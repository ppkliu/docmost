import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AiService } from './ai.service';
import { AiAnswerService } from './ai-answer.service';
import { AiProviderService, ResolvedAiConfig } from './ai-provider.service';
import { AiConnectionService } from './ai-connection.service';
import { AiGenerateDto } from './dto/ai-generate.dto';
import { AiAnswerDto } from './dto/ai-answer.dto';
import { AiSettingsDto, AiTestDto } from './dto/ai-settings.dto';
import {
  KbConnectorIdDto,
  TestKbConnectorDto,
  UpsertKbConnectorDto,
} from './dto/ai-kb.dto';
import { AiKbService, KbConnector } from './ai-kb.service';
import { KbSyncService } from './kb-sync.service';
import { encryptSecret } from './secret.util';
import { EnvironmentService } from '../environment/environment.service';
import { AI_ACTION_IDS } from './prompts';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly aiAnswerService: AiAnswerService,
    private readonly aiProviderService: AiProviderService,
    private readonly aiConnectionService: AiConnectionService,
    private readonly aiKbService: AiKbService,
    private readonly kbSyncService: KbSyncService,
    private readonly environmentService: EnvironmentService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Get('config')
  config(@AuthWorkspace() workspace: Workspace) {
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    return {
      configured: this.aiProviderService.isConfigured(cfg) && this.isEnabled(workspace),
      availableActions: AI_ACTION_IDS,
      provider: this.maskedProvider(cfg),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('settings')
  async updateSettings(
    @Body() dto: AiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    const merged = this.mergeProvider(workspace, dto);
    await this.workspaceRepo.updateAiProvider(workspace.id, merged);

    const cfg = this.aiProviderService.resolveConfig({
      ai: { provider: merged },
    } as any);
    return {
      configured: this.aiProviderService.isConfigured(cfg),
      provider: this.maskedProvider(cfg),
    };
  }

  /**
   * Tests connectivity for the draft config (form values merged over the
   * stored workspace config + env) — lets admins test before saving.
   */
  @HttpCode(HttpStatus.OK)
  @Post('settings/test')
  async testSettings(
    @Body() dto: AiTestDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    const cfg = this.resolveDraft(workspace, dto);
    const targets =
      dto.targets ??
      (this.aiProviderService.isEmbeddingConfigured(cfg)
        ? undefined // both
        : ['completion' as const]);
    const results = await this.aiConnectionService.testConnection(
      cfg,
      targets,
    );
    return {
      success: results.every((r) => r.success),
      results,
    };
  }

  /** Lists models available at the (draft) endpoint, for the model pickers. */
  @HttpCode(HttpStatus.OK)
  @Post('settings/models')
  async discoverModels(
    @Body() dto: AiSettingsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    const cfg = this.resolveDraft(workspace, dto);
    try {
      return await this.aiConnectionService.discoverModels(cfg);
    } catch (err) {
      this.logger.warn(`AI model discovery failed: ${(err as Error)?.message}`);
      throw new BadRequestException(
        'Could not list models from the endpoint — check the base URL and API key',
      );
    }
  }

  // ==========================================================================
  // Knowledge-base connectors (K1) — admin only
  // ==========================================================================

  /** Lists configured external KB connectors (apiKey masked). */
  @HttpCode(HttpStatus.OK)
  @Get('kb')
  listKbConnectors(@AuthWorkspace() workspace: Workspace) {
    return {
      connectors: this.aiKbService.maskConnectors(workspace.settings as any),
    };
  }

  /** Creates or updates a connector. Sync transitions trigger backfill/teardown (K3). */
  @HttpCode(HttpStatus.OK)
  @Post('kb')
  async upsertKbConnector(
    @Body() dto: UpsertKbConnectorDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    const prev = dto.id
      ? this.aiKbService
          .getConnectors(workspace.settings as any)
          .find((kb) => kb.id === dto.id)
      : undefined;
    const next = this.aiKbService.upsertConnector(
      workspace.settings as any,
      dto,
    );
    await this.workspaceRepo.updateAiKnowledgeBases(workspace.id, next as any);

    const updated = next.find((kb) =>
      dto.id ? kb.id === dto.id : !prev && kb.name === dto.name.trim(),
    );
    const wasSynced = Boolean(prev?.sync && prev?.enabled);
    const isSynced = Boolean(updated?.sync && updated?.enabled);
    if (updated && !wasSynced && isSynced) {
      await this.kbSyncService.scheduleBackfill(updated.id, workspace.id);
    } else if (updated && wasSynced && !isSynced) {
      await this.kbSyncService.scheduleTeardown(updated.id, workspace.id);
    }

    return {
      connectors: this.aiKbService.maskConnectors({
        ai: { knowledgeBases: next },
      }),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('kb/delete')
  async deleteKbConnector(
    @Body() dto: KbConnectorIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    // teardown must run while the connector config (credentials) still
    // exists — inline, best-effort
    const existing = this.aiKbService
      .getConnectors(workspace.settings as any)
      .find((kb) => kb.id === dto.id);
    if (existing?.sync) {
      try {
        await this.kbSyncService.teardown(existing.id, workspace.id);
      } catch (err) {
        this.logger.warn(
          `KB teardown on delete failed (${existing.name}): ${(err as Error)?.message}`,
        );
      }
    }

    const next = this.aiKbService.removeConnector(
      workspace.settings as any,
      dto.id,
    );
    await this.workspaceRepo.updateAiKnowledgeBases(workspace.id, next as any);
    return {
      connectors: this.aiKbService.maskConnectors({
        ai: { knowledgeBases: next },
      }),
    };
  }

  /** Tests a stored connector (id) or a draft; draft apiKey falls back to stored. */
  @HttpCode(HttpStatus.OK)
  @Post('kb/test')
  async testKbConnector(
    @Body() dto: TestKbConnectorDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);

    const stored = dto.id
      ? this.aiKbService
          .getConnectors(workspace.settings as any)
          .find((kb) => kb.id === dto.id)
      : undefined;
    if (dto.id && !stored) {
      throw new BadRequestException(`Unknown connector: ${dto.id}`);
    }

    const connector: KbConnector = {
      id: stored?.id ?? 'draft',
      type: dto.type ?? stored?.type ?? 'custom',
      name: stored?.name ?? 'draft',
      baseUrl: dto.baseUrl ?? stored?.baseUrl ?? '',
      apiKey: dto.apiKey || stored?.apiKey,
      searchPath: dto.searchPath ?? stored?.searchPath,
      enabled: true,
    };
    if (!connector.baseUrl) {
      throw new BadRequestException('Base URL is required');
    }
    return this.aiKbService.testConnector(connector);
  }

  /**
   * Merges the dto over the stored provider config. An explicit empty string
   * deletes the override (env fallback resumes); `clearApiKey` deletes the
   * secret; a blank/omitted apiKey keeps it. New keys are encrypted at rest.
   */
  private mergeProvider(
    workspace: Workspace,
    dto: AiSettingsDto,
  ): Record<string, unknown> {
    const current =
      ((workspace.settings as any)?.ai?.provider as Record<string, unknown>) ??
      {};

    const merged: Record<string, unknown> = { ...current };
    for (const key of [
      'driver',
      'baseUrl',
      'embeddingBaseUrl',
      'completionModel',
      'embeddingModel',
      'embeddingDimension',
    ] as const) {
      if (typeof dto[key] === 'undefined') continue;
      if (dto[key] === '' || dto[key] === 0) {
        delete merged[key];
      } else {
        merged[key] = dto[key];
      }
    }
    for (const key of ['baseUrl', 'embeddingBaseUrl'] as const) {
      if (typeof merged[key] === 'string') {
        merged[key] = this.aiConnectionService.normalizeBaseUrl(
          merged[key] as string,
        );
      }
    }
    if (dto.clearApiKey) {
      delete merged.apiKey;
    } else if (dto.apiKey) {
      merged.apiKey = encryptSecret(
        dto.apiKey,
        this.environmentService.getAppSecret(),
      );
    }
    return merged;
  }

  /** Resolves a draft config without persisting it (for test/discover). */
  private resolveDraft(
    workspace: Workspace,
    dto: AiSettingsDto,
  ): ResolvedAiConfig {
    const merged = this.mergeProvider(workspace, dto);
    // The draft key arrives in plaintext; mergeProvider encrypted it and
    // resolveConfig transparently decrypts, so no special-casing needed.
    return this.aiProviderService.resolveConfig({
      ai: { provider: merged },
    } as any);
  }

  private maskedProvider(cfg: ResolvedAiConfig) {
    // apiKey is never returned — only whether one is set.
    return {
      driver: cfg.driver,
      baseUrl: cfg.baseUrl,
      // Echoed back resolved (falls back to baseUrl), so the UI can show what
      // embeddings will actually hit rather than an empty field.
      embeddingBaseUrl: cfg.embeddingBaseUrl,
      completionModel: cfg.completionModel,
      embeddingModel: cfg.embeddingModel,
      embeddingDimension: cfg.embeddingDimension,
      hasApiKey: Boolean(cfg.apiKey),
      embeddingConfigured: this.aiProviderService.isEmbeddingConfigured(cfg),
    };
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generate(
    @Body() dto: AiGenerateDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    this.assertEnabled(workspace, cfg);
    return this.aiService.generate(dto.action, dto.content, dto.prompt, cfg);
  }

  @SkipTransform()
  @Post('generate/stream')
  async generateStream(
    @Body() dto: AiGenerateDto,
    @AuthWorkspace() workspace: Workspace,
    @Res() reply: FastifyReply,
  ) {
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    this.assertEnabled(workspace, cfg);

    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    try {
      const stream = this.aiService.streamGenerate(
        dto.action,
        dto.content,
        dto.prompt,
        cfg,
      );
      for await (const delta of stream) {
        reply.raw.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      this.logger.error(`AI generate stream failed: ${(err as Error)?.message}`);
      reply.raw.write(
        `data: ${JSON.stringify({ error: (err as Error)?.message ?? 'AI error' })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  }

  @SkipTransform()
  @Post('answers')
  async answers(
    @Body() dto: AiAnswerDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() reply: FastifyReply,
  ) {
    const settings = workspace.settings as { ai?: { search?: boolean } } | null;
    if (settings?.ai?.search !== true) {
      throw new ForbiddenException(
        'AI Search is not enabled for this workspace',
      );
    }
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    if (!this.aiAnswerService.isConfigured(cfg)) {
      throw new BadRequestException(
        'AI embeddings are not configured on this server',
      );
    }

    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    try {
      const { sources, context } = await this.aiAnswerService.retrieve(
        dto.query,
        { userId: user.id, workspaceId: workspace.id, spaceId: dto.spaceId },
        cfg,
      );

      for await (const delta of this.aiAnswerService.streamAnswer(
        dto.query,
        context,
        cfg,
      )) {
        reply.raw.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }

      reply.raw.write(`data: ${JSON.stringify({ sources })}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      this.logger.error(`AI answers failed: ${(err as Error)?.message}`);
      reply.raw.write(
        `data: ${JSON.stringify({ error: (err as Error)?.message ?? 'AI error' })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  }

  private isEnabled(workspace: Workspace): boolean {
    const settings = workspace.settings as {
      ai?: { generative?: boolean };
    } | null;
    return settings?.ai?.generative === true;
  }

  private assertEnabled(
    workspace: Workspace,
    cfg = this.aiProviderService.resolveConfig(workspace.settings as any),
  ) {
    if (!this.isEnabled(workspace)) {
      throw new ForbiddenException(
        'Generative AI is not enabled for this workspace',
      );
    }
    if (!this.aiProviderService.isConfigured(cfg)) {
      throw new BadRequestException('AI is not configured on this server');
    }
  }
}
