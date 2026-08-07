import { AiConnectionService } from './ai-connection.service';
import type { ResolvedAiConfig } from './ai-provider.service';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  embed: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateText, embed } = require('ai');

function makeCfg(overrides: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig {
  return {
    driver: 'openai-compatible',
    baseUrl: 'http://llm.local/v1',
    // same host unless a test says otherwise — mirrors resolveConfig's fallback
    embeddingBaseUrl: 'http://llm.local/v1',
    apiKey: 'sk-test',
    completionModel: 'qwen3-32b',
    embeddingModel: 'bge-m3',
    embeddingDimension: 1024,
    ...overrides,
  };
}

function makeService(providerOverrides: Record<string, any> = {}) {
  const provider = {
    completionModel: jest.fn().mockReturnValue({ modelId: 'mock' }),
    embeddingModel: jest.fn().mockReturnValue({ modelId: 'mock-embed' }),
    ...providerOverrides,
  };
  return new AiConnectionService(provider as any);
}

function mockFetchOnce(status: number, body: any) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = jest.fn();
});

describe('AiConnectionService.normalizeBaseUrl', () => {
  const svc = makeService();

  it.each([
    ['http://h:1234/v1/', 'http://h:1234/v1'],
    ['http://h:1234/v1//', 'http://h:1234/v1'],
    ['  http://h:1234/v1 ', 'http://h:1234/v1'],
    ['http://h:1234/v1/models', 'http://h:1234/v1'],
    ['http://h:1234/v1/chat/completions', 'http://h:1234/v1'],
    ['http://h:1234/v1/embeddings', 'http://h:1234/v1'],
    ['http://h:1234', 'http://h:1234'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(svc.normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('AiConnectionService.testConnection', () => {
  it('reports completion and embedding separately on success', async () => {
    const svc = makeService();
    generateText.mockResolvedValue({ text: 'hi' });
    embed.mockResolvedValue({ embedding: new Array(1024).fill(0) });

    const results = await svc.testConnection(makeCfg());
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.target === 'completion')?.success).toBe(true);
    expect(results.find((r) => r.target === 'embedding')?.success).toBe(true);
    expect(
      results.find((r) => r.target === 'embedding')?.message,
    ).toContain('1024');
  });

  it('fails the embedding target on a dimension mismatch', async () => {
    const svc = makeService();
    embed.mockResolvedValue({ embedding: new Array(768).fill(0) });

    const results = await svc.testConnection(makeCfg(), ['embedding']);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain('768');
    expect(results[0].message).toContain('1024');
  });

  it('maps 401-style errors to an invalid-key message', async () => {
    const svc = makeService();
    generateText.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    );

    const results = await svc.testConnection(makeCfg(), ['completion']);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toBe('Invalid API key');
  });

  it('maps connection failures to a reachability message', async () => {
    const svc = makeService();
    generateText.mockRejectedValue(new Error('fetch failed'));

    const results = await svc.testConnection(makeCfg(), ['completion']);
    expect(results[0].message).toContain('Cannot reach');
  });

  it('fails embedding gracefully when no embedding model is set', async () => {
    const svc = makeService();
    const results = await svc.testConnection(
      makeCfg({ embeddingModel: '' }),
      ['embedding'],
    );
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain('No embedding model');
    expect(embed).not.toHaveBeenCalled();
  });

  it('never echoes bearer tokens in error messages', async () => {
    const svc = makeService();
    generateText.mockRejectedValue(
      new Error('request with header Bearer sk-secret-123 was rejected'),
    );

    const results = await svc.testConnection(makeCfg(), ['completion']);
    expect(results[0].message).not.toContain('sk-secret-123');
  });
});

describe('AiConnectionService.discoverModels', () => {
  it('lists openai-compatible models via GET {base}/models with auth', async () => {
    const svc = makeService();
    mockFetchOnce(200, { data: [{ id: 'b-model' }, { id: 'a-model' }] });

    const out = await svc.discoverModels(makeCfg());
    expect(out.models).toEqual(['a-model', 'b-model']);
    expect(out.normalizedBaseUrl).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://llm.local/v1/models',
      expect.objectContaining({
        headers: { authorization: 'Bearer sk-test' },
      }),
    );
  });

  it('suggests /v1 when the bare base URL 404s but /v1/models works', async () => {
    const svc = makeService();
    mockFetchOnce(404, {});
    mockFetchOnce(200, { data: [{ id: 'm' }] });

    const out = await svc.discoverModels(makeCfg({ baseUrl: 'http://llm.local' }));
    expect(out.models).toEqual(['m']);
    expect(out.normalizedBaseUrl).toBe('http://llm.local/v1');
  });

  it('lists ollama models via /api/tags', async () => {
    const svc = makeService();
    mockFetchOnce(200, { models: [{ name: 'llama3:8b' }] });

    const out = await svc.discoverModels(
      makeCfg({ driver: 'ollama', baseUrl: 'http://ollama:11434' }),
    );
    expect(out.models).toEqual(['llama3:8b']);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://ollama:11434/api/tags',
      expect.anything(),
    );
  });

  it('strips the models/ prefix for gemini', async () => {
    const svc = makeService();
    mockFetchOnce(200, { models: [{ name: 'models/gemini-2.0-flash' }] });

    const out = await svc.discoverModels(makeCfg({ driver: 'gemini' }));
    expect(out.models).toEqual(['gemini-2.0-flash']);
  });

  it('returns empty for openai-compatible without a base URL', async () => {
    const svc = makeService();
    const out = await svc.discoverModels(makeCfg({ baseUrl: '' }));
    expect(out.models).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
