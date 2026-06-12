import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { EmbeddingModel, LanguageModel } from 'ai';
import { EnvironmentService } from '../environment/environment.service';
import { decryptSecret } from './secret.util';

/** A fully-resolved provider config (workspace overrides env, per field). */
export interface ResolvedAiConfig {
  driver: string;
  baseUrl: string;
  apiKey: string;
  completionModel: string;
  embeddingModel: string;
  embeddingDimension: number;
}

/** Shape of the per-workspace override stored in `settings.ai.provider`. */
export interface AiProviderOverride {
  driver?: string;
  baseUrl?: string;
  apiKey?: string;
  completionModel?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
}

type WorkspaceAiSettings = {
  ai?: { provider?: AiProviderOverride };
} | null;

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  /**
   * Merges the per-workspace `settings.ai.provider` override over the env
   * defaults, field by field, so a partial UI config still falls back to env.
   * The api key / base url env source depends on the (resolved) driver.
   */
  resolveConfig(settings?: WorkspaceAiSettings): ResolvedAiConfig {
    const p = settings?.ai?.provider ?? {};
    const driver = (
      p.driver ||
      this.environmentService.getAiDriver() ||
      ''
    ).toLowerCase();

    const envApiKey =
      driver === 'gemini'
        ? this.environmentService.getGeminiApiKey()
        : this.environmentService.getOpenAiApiKey();
    const envBaseUrl =
      driver === 'ollama'
        ? this.environmentService.getOllamaApiUrl()
        : this.environmentService.getOpenAiApiUrl();

    // Workspace-stored keys are encrypted at rest (legacy plaintext passes
    // through). Decryption failure (rotated APP_SECRET) resolves as "no key"
    // so the UI shows "not set" instead of every AI call failing.
    let workspaceApiKey = p.apiKey || '';
    if (workspaceApiKey) {
      const decrypted = decryptSecret(
        workspaceApiKey,
        this.environmentService.getAppSecret(),
      );
      if (decrypted === null) {
        this.logger.warn(
          'Failed to decrypt the stored AI provider apiKey (APP_SECRET changed?); treating it as unset',
        );
      }
      workspaceApiKey = decrypted ?? '';
    }

    return {
      driver,
      baseUrl: p.baseUrl || envBaseUrl || '',
      apiKey: workspaceApiKey || envApiKey || '',
      completionModel:
        p.completionModel || this.environmentService.getAiCompletionModel() || '',
      embeddingModel:
        p.embeddingModel || this.environmentService.getAiEmbeddingModel() || '',
      embeddingDimension:
        p.embeddingDimension ||
        this.environmentService.getAiEmbeddingDimension(),
    };
  }

  isConfigured(cfg: ResolvedAiConfig = this.resolveConfig()): boolean {
    return Boolean(cfg.driver && cfg.completionModel);
  }

  /** Whether embeddings (AI Answers / RAG) are configured. */
  isEmbeddingConfigured(cfg: ResolvedAiConfig = this.resolveConfig()): boolean {
    return Boolean(cfg.driver && cfg.embeddingModel && cfg.embeddingDimension);
  }

  embeddingDimension(cfg: ResolvedAiConfig = this.resolveConfig()): number {
    return cfg.embeddingDimension;
  }

  /**
   * Returns a Vercel AI SDK text-embedding model for the resolved config,
   * used by the ingestion pipeline and the AI Answers query path.
   */
  embeddingModel(cfg: ResolvedAiConfig = this.resolveConfig()): EmbeddingModel {
    if (!cfg.driver || !cfg.embeddingModel) {
      throw new BadRequestException(
        'AI embeddings are not configured on this server',
      );
    }

    switch (cfg.driver) {
      case 'openai': {
        const openai = createOpenAI({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl || undefined,
        });
        return openai.textEmbeddingModel(cfg.embeddingModel);
      }
      case 'openai-compatible': {
        const provider = createOpenAICompatible({
          name: 'docmost-openai-compatible',
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl,
        });
        return provider.textEmbeddingModel(cfg.embeddingModel);
      }
      case 'gemini': {
        const google = createGoogleGenerativeAI({ apiKey: cfg.apiKey });
        return google.textEmbeddingModel(cfg.embeddingModel);
      }
      case 'ollama': {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createOllama } = require('ai-sdk-ollama');
        const ollama = createOllama({ baseURL: cfg.baseUrl });
        return ollama.textEmbeddingModel(cfg.embeddingModel);
      }
      default:
        throw new BadRequestException(`Unsupported AI_DRIVER: ${cfg.driver}`);
    }
  }

  /**
   * Returns a Vercel AI SDK language model for the resolved config.
   */
  completionModel(cfg: ResolvedAiConfig = this.resolveConfig()): LanguageModel {
    if (!cfg.driver || !cfg.completionModel) {
      throw new BadRequestException('AI is not configured on this server');
    }

    switch (cfg.driver) {
      case 'openai': {
        const openai = createOpenAI({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl || undefined,
        });
        return openai(cfg.completionModel);
      }
      case 'openai-compatible': {
        const provider = createOpenAICompatible({
          name: 'docmost-openai-compatible',
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl,
        });
        return provider(cfg.completionModel);
      }
      case 'gemini': {
        const google = createGoogleGenerativeAI({ apiKey: cfg.apiKey });
        return google(cfg.completionModel);
      }
      case 'ollama': {
        // ai-sdk-ollama is ESM (type: module) with a CJS condition; load via
        // require so it resolves under the server's CommonJS build.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createOllama } = require('ai-sdk-ollama');
        const ollama = createOllama({ baseURL: cfg.baseUrl });
        return ollama(cfg.completionModel);
      }
      default:
        throw new BadRequestException(`Unsupported AI_DRIVER: ${cfg.driver}`);
    }
  }
}
