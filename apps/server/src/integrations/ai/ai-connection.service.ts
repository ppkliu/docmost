import { Injectable, Logger } from '@nestjs/common';
import { embed, generateText } from 'ai';
import { AiProviderService, ResolvedAiConfig } from './ai-provider.service';

export type AiTestTarget = 'completion' | 'embedding';

export interface AiTestResult {
  target: AiTestTarget;
  success: boolean;
  message: string;
  latencyMs: number;
}

export interface AiDiscoveredModels {
  models: string[];
  /** Set when the listing only succeeded after appending /v1 — a suggestion, never auto-applied. */
  normalizedBaseUrl?: string;
}

const TEST_TIMEOUT_MS = 10_000;

/**
 * Connectivity probes for the workspace AI provider settings: connection
 * test (completion + embedding) and model discovery. Mirrors open-notebook's
 * credentials test/discover endpoints, adapted to docmost's single
 * workspace-level config.
 */
@Injectable()
export class AiConnectionService {
  private readonly logger = new Logger(AiConnectionService.name);

  constructor(private readonly aiProviderService: AiProviderService) {}

  /**
   * Cleans up an admin-entered base URL: trims, strips trailing slashes and
   * accidentally-pasted endpoint suffixes. Never invents path segments.
   */
  normalizeBaseUrl(url: string): string {
    let out = url.trim();
    out = out.replace(/\/+$/, '');
    out = out.replace(/\/(models|chat\/completions|embeddings)$/, '');
    return out.replace(/\/+$/, '');
  }

  async testConnection(
    cfg: ResolvedAiConfig,
    targets?: AiTestTarget[],
  ): Promise<AiTestResult[]> {
    const wanted: AiTestTarget[] =
      targets && targets.length > 0 ? targets : ['completion', 'embedding'];

    const runs = wanted.map(async (target): Promise<AiTestResult> => {
      const started = Date.now();
      try {
        if (target === 'completion') {
          await this.withTimeout(this.testCompletion(cfg));
          return {
            target,
            success: true,
            message: `Connected (${cfg.completionModel})`,
            latencyMs: Date.now() - started,
          };
        }

        if (!cfg.embeddingModel) {
          return {
            target,
            success: false,
            message: 'No embedding model configured',
            latencyMs: 0,
          };
        }
        const dimension = await this.withTimeout(this.testEmbedding(cfg));
        if (cfg.embeddingDimension && dimension !== cfg.embeddingDimension) {
          return {
            target,
            success: false,
            message: `Dimension mismatch: model returns ${dimension}, configured ${cfg.embeddingDimension}`,
            latencyMs: Date.now() - started,
          };
        }
        return {
          target,
          success: true,
          message: `Connected (${cfg.embeddingModel}, dimension ${dimension})`,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        return {
          target,
          success: false,
          message: this.describeError(err),
          latencyMs: Date.now() - started,
        };
      }
    });

    return Promise.all(runs);
  }

  private async testCompletion(cfg: ResolvedAiConfig): Promise<void> {
    const model = this.aiProviderService.completionModel(cfg);
    await generateText({
      model,
      prompt: 'Hi',
      maxOutputTokens: 8,
    });
  }

  /** Returns the embedding dimension actually produced by the model. */
  private async testEmbedding(cfg: ResolvedAiConfig): Promise<number> {
    const model = this.aiProviderService.embeddingModel(cfg);
    const { embedding } = await embed({ model, value: 'ping' });
    return embedding.length;
  }

  async discoverModels(cfg: ResolvedAiConfig): Promise<AiDiscoveredModels> {
    const driver = cfg.driver;

    if (driver === 'ollama') {
      const base = this.normalizeBaseUrl(cfg.baseUrl || 'http://localhost:11434');
      const data = await this.fetchJson(`${base}/api/tags`);
      return {
        models: (data?.models ?? [])
          .map((m: any) => m?.name)
          .filter(Boolean),
      };
    }

    if (driver === 'gemini') {
      if (!cfg.apiKey) return { models: [] };
      const data = await this.fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.apiKey)}`,
      );
      return {
        models: (data?.models ?? [])
          .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
          .filter(Boolean),
      };
    }

    // openai / openai-compatible: OpenAI-style GET {base}/models
    const base = this.normalizeBaseUrl(
      cfg.baseUrl || (driver === 'openai' ? 'https://api.openai.com/v1' : ''),
    );
    if (!base) return { models: [] };

    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

    try {
      const data = await this.fetchJson(`${base}/models`, headers);
      return { models: this.parseOpenAiModels(data) };
    } catch (err) {
      // Common miss: base URL without /v1. Suggest the fix instead of failing.
      if (
        driver === 'openai-compatible' &&
        !/\/v\d+$/.test(base) &&
        this.isNotFound(err)
      ) {
        const withV1 = `${base}/v1`;
        const data = await this.fetchJson(`${withV1}/models`, headers);
        return {
          models: this.parseOpenAiModels(data),
          normalizedBaseUrl: withV1,
        };
      }
      throw err;
    }
  }

  private parseOpenAiModels(data: any): string[] {
    return (data?.data ?? [])
      .map((m: any) => m?.id)
      .filter(Boolean)
      .map(String)
      .sort();
  }

  private async fetchJson(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<any> {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err: any = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  }

  private isNotFound(err: unknown): boolean {
    return (err as any)?.status === 404;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${TEST_TIMEOUT_MS / 1000}s`)),
          TEST_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  }

  /** Maps SDK/fetch errors to admin-friendly messages — never echoes secrets. */
  private describeError(err: unknown): string {
    const msg = (err as Error)?.message ?? String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode;

    if (status === 401 || /unauthorized|invalid.*api key/i.test(msg)) {
      return 'Invalid API key';
    }
    if (status === 403 || /forbidden/i.test(msg)) {
      return 'API key lacks required permissions';
    }
    if (status === 404 || /not found/i.test(msg)) {
      return 'Endpoint not found — check the base URL (it usually ends with /v1)';
    }
    if (/timed? ?out/i.test(msg)) {
      return msg;
    }
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return 'Cannot reach the server — check the base URL and network';
    }
    // strip anything that looks like a bearer token before echoing
    return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
  }
}
