import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import { decryptSecret, encryptSecret } from './secret.util';
import { nanoIdGen } from '../../common/helpers/nanoid.utils';

export const KB_TYPES = ['cognee', 'llm-wiki', 'custom'] as const;
export type KbType = (typeof KB_TYPES)[number];

/** Stored shape in settings.ai.knowledgeBases[] (apiKey encrypted at rest). */
export interface KbConnector {
  id: string;
  type: KbType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Optional search path override for custom servers (default /search). */
  searchPath?: string;
  enabled: boolean;
  /** K3: mirror docmost content into this KB (cognee only). */
  sync?: boolean;
}

export interface KbConnectorMasked extends Omit<KbConnector, 'apiKey'> {
  hasApiKey: boolean;
}

export interface KbSearchResult {
  title: string;
  content: string;
  url?: string;
  score?: number;
}

type WorkspaceAiSettings = {
  ai?: { knowledgeBases?: KbConnector[] };
} | null;

const SEARCH_TIMEOUT_MS = 15_000;

/**
 * External knowledge-base connectors (Cognee / LLM-Wiki / custom
 * OpenAPI-style search servers) stored per workspace in
 * settings.ai.knowledgeBases. Mirrors the E9.1 AI-provider pattern:
 * encrypted apiKey at rest, masked responses, draft-able connection test.
 * Chat federation (K2) consumes search() per enabled connector.
 */
@Injectable()
export class AiKbService {
  private readonly logger = new Logger(AiKbService.name);

  constructor(private readonly environmentService: EnvironmentService) {}

  /** Connectors with decrypted keys — for internal use only, never serialized. */
  getConnectors(settings?: WorkspaceAiSettings): KbConnector[] {
    const stored = settings?.ai?.knowledgeBases ?? [];
    return stored.map((kb) => ({
      ...kb,
      apiKey: kb.apiKey
        ? (decryptSecret(kb.apiKey, this.environmentService.getAppSecret()) ??
          undefined)
        : undefined,
    }));
  }

  /** Masked connectors for API responses. */
  maskConnectors(settings?: WorkspaceAiSettings): KbConnectorMasked[] {
    return (settings?.ai?.knowledgeBases ?? []).map((kb) => {
      const { apiKey, ...rest } = kb;
      return { ...rest, hasApiKey: Boolean(apiKey) };
    });
  }

  /**
   * Builds the next stored connector list for a create/update. The incoming
   * apiKey is plaintext and gets encrypted; blank keeps the stored key;
   * clearApiKey removes it.
   */
  upsertConnector(
    settings: WorkspaceAiSettings,
    input: {
      id?: string;
      type: KbType;
      name: string;
      baseUrl: string;
      apiKey?: string;
      clearApiKey?: boolean;
      searchPath?: string;
      enabled?: boolean;
      sync?: boolean;
    },
  ): KbConnector[] {
    const list = [...(settings?.ai?.knowledgeBases ?? [])];
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    if (!baseUrl) {
      throw new BadRequestException('Base URL is required');
    }

    const existingIndex = input.id
      ? list.findIndex((kb) => kb.id === input.id)
      : -1;
    if (input.id && existingIndex === -1) {
      throw new BadRequestException(`Unknown connector: ${input.id}`);
    }
    const existing = existingIndex >= 0 ? list[existingIndex] : undefined;

    let storedKey = existing?.apiKey;
    if (input.clearApiKey) {
      storedKey = undefined;
    } else if (input.apiKey) {
      storedKey = encryptSecret(
        input.apiKey,
        this.environmentService.getAppSecret(),
      );
    }

    const next: KbConnector = {
      id: existing?.id ?? `kb_${nanoIdGen(8)}`,
      type: input.type,
      name: input.name.trim(),
      baseUrl,
      apiKey: storedKey,
      searchPath: input.searchPath?.trim() || undefined,
      enabled: input.enabled ?? existing?.enabled ?? true,
      // sync is cognee-only; other types ignore it
      sync:
        input.type === 'cognee'
          ? (input.sync ?? existing?.sync ?? false)
          : undefined,
    };

    if (existingIndex >= 0) {
      list[existingIndex] = next;
    } else {
      list.push(next);
    }
    return list;
  }

  removeConnector(
    settings: WorkspaceAiSettings,
    id: string,
  ): KbConnector[] {
    const list = settings?.ai?.knowledgeBases ?? [];
    const next = list.filter((kb) => kb.id !== id);
    if (next.length === list.length) {
      throw new BadRequestException(`Unknown connector: ${id}`);
    }
    return next;
  }

  normalizeBaseUrl(url: string): string {
    return (url ?? '').trim().replace(/\/+$/, '');
  }

  /** Reachability/auth probe. Never throws; returns an admin-friendly result. */
  async testConnector(
    connector: KbConnector,
  ): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const results = await this.search(connector, 'ping', { limit: 1 });
      return {
        success: true,
        message: `Connected (${results.length} result${results.length === 1 ? '' : 's'} for test query)`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        success: false,
        message: this.describeError(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  /**
   * Runs a search against one connector. Per-type adapters:
   * - cognee:   POST {base}/api/v1/search  { searchType: "CHUNKS", query }
   * - llm-wiki: POST {base}/api/search     { query, limit }
   * - custom:   POST {base}{searchPath||/search}  { query, limit }
   * All tolerate `{results: [...]}`, bare arrays, and string items.
   */
  async search(
    connector: KbConnector,
    query: string,
    opts: { limit?: number; datasets?: string[] } = {},
  ): Promise<KbSearchResult[]> {
    const limit = opts.limit ?? 5;
    const base = this.normalizeBaseUrl(connector.baseUrl);

    let url: string;
    let body: Record<string, unknown>;
    switch (connector.type) {
      case 'cognee':
        url = `${base}/api/v1/search`;
        body = { searchType: 'CHUNKS', query, topK: limit };
        // K4.1: synced connectors search only the caller's space datasets
        if (opts.datasets) body.datasets = opts.datasets;
        break;
      case 'llm-wiki':
        url = `${base}/api/search`;
        body = { query, limit };
        break;
      default:
        url = `${base}${connector.searchPath || '/search'}`;
        body = { query, limit };
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (connector.apiKey) {
      headers.authorization = `Bearer ${connector.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err: any = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    return this.parseResults(data, limit);
  }

  // ==========================================================================
  // K3: cognee ingest adapters (rebuild-per-space sync strategy)
  // ==========================================================================

  /** Cognee dataset name for a docmost space. */
  datasetName(workspaceId: string, spaceId: string): string {
    return `docmost_${workspaceId}_${spaceId}`.replace(/-/g, '');
  }

  async addDocuments(
    connector: KbConnector,
    dataset: string,
    texts: string[],
  ): Promise<void> {
    if (texts.length === 0) return;
    const base = this.normalizeBaseUrl(connector.baseUrl);
    await this.requestJson(connector, 'POST', `${base}/api/v1/add`, {
      data: texts,
      datasetName: dataset,
    });
  }

  async cognify(connector: KbConnector, datasets: string[]): Promise<void> {
    const base = this.normalizeBaseUrl(connector.baseUrl);
    await this.requestJson(connector, 'POST', `${base}/api/v1/cognify`, {
      datasets,
    });
  }

  /** Lists datasets as {id, name}; tolerant of shape variations. */
  async listDatasets(
    connector: KbConnector,
  ): Promise<{ id: string; name: string }[]> {
    const base = this.normalizeBaseUrl(connector.baseUrl);
    const data = await this.requestJson(
      connector,
      'GET',
      `${base}/api/v1/datasets`,
    );
    const raw = Array.isArray(data) ? data : (data?.items ?? data?.data ?? []);
    return (Array.isArray(raw) ? raw : [])
      .map((d: any) => ({
        id: String(d?.id ?? ''),
        name: String(d?.name ?? ''),
      }))
      .filter((d) => d.id && d.name);
  }

  /** Deletes a dataset by name. Missing datasets are not an error. */
  async deleteDatasetByName(
    connector: KbConnector,
    name: string,
  ): Promise<void> {
    const datasets = await this.listDatasets(connector);
    const match = datasets.find((d) => d.name === name);
    if (!match) return;
    const base = this.normalizeBaseUrl(connector.baseUrl);
    try {
      await this.requestJson(
        connector,
        'DELETE',
        `${base}/api/v1/datasets/${match.id}`,
      );
    } catch (err) {
      if ((err as any)?.status === 404) return;
      throw err;
    }
  }

  private async requestJson(
    connector: KbConnector,
    method: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (connector.apiKey) {
      headers.authorization = `Bearer ${connector.apiKey}`;
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err: any = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    // some endpoints return empty bodies
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private parseResults(data: any, limit: number): KbSearchResult[] {
    const raw = Array.isArray(data)
      ? data
      : (data?.results ?? data?.items ?? data?.data ?? []);
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, limit).map((item: any) => {
      if (typeof item === 'string') {
        return { title: '', content: item };
      }
      return {
        title: String(item?.title ?? item?.name ?? ''),
        content: String(
          item?.content ?? item?.text ?? item?.excerpt ?? item?.chunk ?? '',
        ).slice(0, 2000),
        url: item?.url ?? item?.link ?? undefined,
        score:
          typeof item?.score === 'number'
            ? item.score
            : typeof item?.similarity === 'number'
              ? item.similarity
              : undefined,
      };
    });
  }

  private describeError(err: unknown): string {
    const msg = (err as Error)?.message ?? String(err);
    const status = (err as any)?.status;
    if (status === 401 || status === 403) return 'Authentication failed — check the API key';
    if (status === 404) return 'Search endpoint not found — check the base URL';
    if (/timed? ?out/i.test(msg)) return `Timed out after ${SEARCH_TIMEOUT_MS / 1000}s`;
    if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      return 'Cannot reach the server — check the base URL and network';
    }
    return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
  }
}
