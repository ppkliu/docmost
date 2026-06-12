import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { AiKbService, KbConnector } from './ai-kb.service';
import { QueueJob, QueueName } from '../queue/constants';

/** Debounce window for per-space rebuilds (cognify is expensive). */
const SYNC_DEBOUNCE_MS = 5 * 60 * 1000;
const ADD_BATCH_SIZE = 20;

/**
 * K3: mirrors docmost content into sync-enabled Cognee connectors.
 *
 * v1 strategy: **rebuild-per-space** — every change event schedules a
 * debounced rebuild of the affected space's dataset (delete dataset →
 * re-add every syncable page → cognify once). Correct by construction
 * without relying on per-document delete APIs; incremental upserts are a
 * later optimization. Restricted pages (E7 chain) never leave docmost
 * (same rule as the embedding indexer, K4.2).
 */
@Injectable()
export class KbSyncService {
  private readonly logger = new Logger(KbSyncService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly aiKbService: AiKbService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  private async syncedConnectors(
    workspaceId: string,
  ): Promise<KbConnector[]> {
    const ws = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    return this.aiKbService
      .getConnectors((ws?.settings ?? null) as any)
      .filter((kb) => kb.enabled && kb.sync && kb.type === 'cognee');
  }

  /**
   * Fan-out hook for page change events: schedules a debounced rebuild of
   * each affected space, per sync-enabled connector. Best-effort.
   */
  async schedulePageSync(
    pageIds: string[],
    workspaceId: string,
  ): Promise<void> {
    if (pageIds.length === 0) return;
    try {
      const connectors = await this.syncedConnectors(workspaceId);
      if (connectors.length === 0) return;

      const rows = await this.db
        .selectFrom('pages')
        .select('spaceId')
        .distinct()
        .where('id', 'in', pageIds)
        .where('workspaceId', '=', workspaceId)
        .execute();

      for (const connector of connectors) {
        for (const { spaceId } of rows) {
          await this.scheduleSpaceSync(connector.id, workspaceId, spaceId);
        }
      }
    } catch (err) {
      this.logger.warn(
        `KB sync scheduling failed: ${(err as Error)?.message}`,
      );
    }
  }

  /** Debounced via a stable jobId + delay; later events ride the same job. */
  async scheduleSpaceSync(
    connectorId: string,
    workspaceId: string,
    spaceId: string,
  ): Promise<void> {
    await this.aiQueue.add(
      QueueJob.KB_SYNC_SPACE,
      { connectorId, workspaceId, spaceId },
      {
        jobId: `kb-sync-${connectorId}-${spaceId}`,
        delay: SYNC_DEBOUNCE_MS,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** Backfill on enabling sync: schedule every space in the workspace. */
  async scheduleBackfill(
    connectorId: string,
    workspaceId: string,
  ): Promise<void> {
    const spaces = await this.db
      .selectFrom('spaces')
      .select('id')
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();
    for (const { id } of spaces) {
      await this.scheduleSpaceSync(connectorId, workspaceId, id);
    }
  }

  async scheduleTeardown(
    connectorId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.aiQueue.add(
      QueueJob.KB_TEARDOWN,
      { connectorId, workspaceId },
      { removeOnComplete: true, removeOnFail: true },
    );
  }

  /** Job handler: rebuilds one space's dataset on one connector. */
  async syncSpace(
    connectorId: string,
    workspaceId: string,
    spaceId: string,
  ): Promise<void> {
    const connector = (await this.syncedConnectors(workspaceId)).find(
      (kb) => kb.id === connectorId,
    );
    if (!connector) return; // sync disabled/removed since scheduling

    const dataset = this.aiKbService.datasetName(workspaceId, spaceId);
    await this.aiKbService.deleteDatasetByName(connector, dataset);

    const pages = await this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent'])
      .where('spaceId', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    const texts: string[] = [];
    for (const page of pages) {
      const content = (page.textContent ?? '').trim();
      if (!content) continue;
      // K4.2 rule: restricted content never leaves docmost
      if (await this.pagePermissionRepo.hasRestrictedAncestor(page.id)) {
        continue;
      }
      texts.push(`# ${page.title ?? 'Untitled'}\n[docmost:page:${page.id}]\n\n${content}`);
    }

    for (let i = 0; i < texts.length; i += ADD_BATCH_SIZE) {
      await this.aiKbService.addDocuments(
        connector,
        dataset,
        texts.slice(i, i + ADD_BATCH_SIZE),
      );
    }
    if (texts.length > 0) {
      await this.aiKbService.cognify(connector, [dataset]);
    }
    this.logger.log(
      `KB sync: ${texts.length} pages -> ${dataset} (${connector.name})`,
    );
  }

  /** Job handler: removes every docmost dataset for this workspace. */
  async teardown(connectorId: string, workspaceId: string): Promise<void> {
    // the connector may already be deleted/sync-disabled — use any stored
    // config that still exists, otherwise nothing to do
    const ws = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const connector = this.aiKbService
      .getConnectors((ws?.settings ?? null) as any)
      .find((kb) => kb.id === connectorId);
    if (!connector) return;

    const prefix = `docmost_${workspaceId}`.replace(/-/g, '');
    const datasets = await this.aiKbService.listDatasets(connector);
    for (const d of datasets) {
      if (d.name.startsWith(prefix)) {
        await this.aiKbService.deleteDatasetByName(connector, d.name);
      }
    }
  }
}
