import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { embedMany } from 'ai';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  EmbeddingChunkInput,
  EmbeddingRepo,
} from '@docmost/db/repos/embedding/embedding.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AiProviderService, ResolvedAiConfig } from './ai-provider.service';
import { chunkText } from './embedding.util';

@Injectable()
export class AiIndexingService {
  private readonly logger = new Logger(AiIndexingService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly embeddingRepo: EmbeddingRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly aiProviderService: AiProviderService,
  ) {}

  /** Resolves the effective AI config (workspace override over env) for a workspace. */
  private async resolveWorkspaceConfig(
    workspaceId: string,
  ): Promise<ResolvedAiConfig> {
    const ws = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return this.aiProviderService.resolveConfig((ws?.settings ?? null) as any);
  }

  /** Embeddings run only when configured AND the workspace has AI Search on. */
  async isEnabled(workspaceId: string): Promise<boolean> {
    const ws = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const settings = (ws?.settings ?? {}) as { ai?: { search?: boolean } };
    if (settings.ai?.search !== true) return false;
    return this.aiProviderService.isEmbeddingConfigured(
      this.aiProviderService.resolveConfig((ws?.settings ?? null) as any),
    );
  }

  async embedPages(pageIds: string[], workspaceId: string): Promise<void> {
    if (pageIds.length === 0) return;
    if (!(await this.isEnabled(workspaceId))) return;

    const cfg = await this.resolveWorkspaceConfig(workspaceId);
    const model = this.aiProviderService.embeddingModel(cfg);
    const modelName = cfg.embeddingModel;
    const modelDimensions = this.aiProviderService.embeddingDimension(cfg);

    for (const pageId of pageIds) {
      const page = await this.db
        .selectFrom('pages')
        .select([
          'id',
          'textContent',
          'spaceId',
          'workspaceId',
          'deletedAt',
          'reviewStatus',
        ])
        .where('id', '=', pageId)
        .where('workspaceId', '=', workspaceId)
        .executeTakeFirst();

      if (!page || page.deletedAt) {
        await this.embeddingRepo.deleteByPageIds([pageId]);
        continue;
      }

      // H2.2: unreviewed agent submissions stay out of retrieval until approved
      if (page.reviewStatus === 'pending' || page.reviewStatus === 'rejected') {
        await this.embeddingRepo.deleteByPageIds([pageId]);
        continue;
      }

      // K4.2: pages under an E7 restriction never enter the retrieval store —
      // AI Answers / chat search filter by space membership only, which is
      // coarser than page-level permissions. Restrict/unrestrict re-enqueues
      // the subtree so this rule re-evaluates.
      if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) {
        await this.embeddingRepo.deleteByPageIds([pageId]);
        continue;
      }

      const chunks = await chunkText(page.textContent ?? '');
      if (chunks.length === 0) {
        await this.embeddingRepo.deleteByPageIds([pageId]);
        continue;
      }

      const { embeddings } = await embedMany({
        model,
        values: chunks.map((c) => c.text),
      });

      const rows: EmbeddingChunkInput[] = chunks.map((c, i) => ({
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId: page.workspaceId,
        modelName,
        modelDimensions,
        embedding: embeddings[i],
        chunkIndex: c.index,
        chunkStart: c.start,
        chunkLength: c.length,
      }));

      await this.embeddingRepo.replacePageChunks(page.id, rows);
    }
  }

  async deletePages(pageIds: string[]): Promise<void> {
    await this.embeddingRepo.deleteByPageIds(pageIds);
  }

  async backfillWorkspace(workspaceId: string): Promise<void> {
    if (!(await this.isEnabled(workspaceId))) return;
    const pageIds = await this.embeddingRepo.listWorkspacePageIds(workspaceId);
    const batchSize = 20;
    for (let i = 0; i < pageIds.length; i += batchSize) {
      await this.embedPages(pageIds.slice(i, i + batchSize), workspaceId);
    }
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.embeddingRepo.deleteByWorkspace(workspaceId);
  }
}
