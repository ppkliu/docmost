import { BadRequestException } from '@nestjs/common';
import { AiKbService, KbConnector } from './ai-kb.service';
import { encryptSecret } from './secret.util';

const ENV = { getAppSecret: () => 'test-app-secret' } as any;

function makeConnector(overrides: Partial<KbConnector> = {}): KbConnector {
  return {
    id: 'kb1',
    type: 'cognee',
    name: 'Team Cognee',
    baseUrl: 'http://kb.local',
    enabled: true,
    ...overrides,
  };
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

describe('AiKbService connector storage', () => {
  const svc = new AiKbService(ENV);

  it('creates a connector with an encrypted key and generated id', () => {
    const list = svc.upsertConnector(null, {
      type: 'cognee',
      name: ' Team Cognee ',
      baseUrl: 'http://kb.local/',
      apiKey: 'sk-kb-secret',
    });
    expect(list).toHaveLength(1);
    expect(list[0].id).toMatch(/^kb_/);
    expect(list[0].name).toBe('Team Cognee');
    expect(list[0].baseUrl).toBe('http://kb.local');
    expect(list[0].enabled).toBe(true);
    expect(list[0].apiKey).toMatch(/^enc:v1:/);
    expect(list[0].apiKey).not.toContain('sk-kb-secret');
  });

  it('updates in place, keeping the stored key when blank', () => {
    const settings = {
      ai: {
        knowledgeBases: [
          makeConnector({ apiKey: encryptSecret('old-key', 'test-app-secret') }),
        ],
      },
    };
    const list = svc.upsertConnector(settings, {
      id: 'kb1',
      type: 'cognee',
      name: 'Renamed',
      baseUrl: 'http://kb.local',
    });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Renamed');
    expect(list[0].apiKey).toMatch(/^enc:v1:/); // preserved

    const cleared = svc.upsertConnector(settings, {
      id: 'kb1',
      type: 'cognee',
      name: 'Renamed',
      baseUrl: 'http://kb.local',
      clearApiKey: true,
    });
    expect(cleared[0].apiKey).toBeUndefined();
  });

  it('rejects unknown ids on update and delete', () => {
    expect(() =>
      svc.upsertConnector(null, {
        id: 'nope',
        type: 'custom',
        name: 'x',
        baseUrl: 'http://x',
      }),
    ).toThrow(BadRequestException);
    expect(() => svc.removeConnector(null, 'nope')).toThrow(
      BadRequestException,
    );
  });

  it('decrypts keys in getConnectors and masks them in maskConnectors', () => {
    const settings = {
      ai: {
        knowledgeBases: [
          makeConnector({ apiKey: encryptSecret('kb-key', 'test-app-secret') }),
        ],
      },
    };
    expect(svc.getConnectors(settings)[0].apiKey).toBe('kb-key');

    const masked = svc.maskConnectors(settings)[0] as any;
    expect(masked.hasApiKey).toBe(true);
    expect(masked.apiKey).toBeUndefined();
  });
});

describe('AiKbService.search', () => {
  const svc = new AiKbService(ENV);

  it('uses the cognee adapter shape with bearer auth', async () => {
    mockFetchOnce(200, { results: [{ title: 'Doc', text: 'chunk text' }] });
    const results = await svc.search(
      makeConnector({ apiKey: 'kb-key' }),
      'roadmap',
      { limit: 3 },
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'http://kb.local/api/v1/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer kb-key',
        }),
        body: JSON.stringify({
          searchType: 'CHUNKS',
          query: 'roadmap',
          topK: 3,
        }),
      }),
    );
    expect(results).toEqual([
      { title: 'Doc', content: 'chunk text', url: undefined, score: undefined },
    ]);
  });

  it('uses /api/search for llm-wiki and the custom searchPath for custom', async () => {
    mockFetchOnce(200, []);
    await svc.search(makeConnector({ type: 'llm-wiki' }), 'q');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      'http://kb.local/api/search',
    );

    mockFetchOnce(200, []);
    await svc.search(
      makeConnector({ type: 'custom', searchPath: '/v1/query' }),
      'q',
    );
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe(
      'http://kb.local/v1/query',
    );
  });

  it('tolerates bare arrays and string items', async () => {
    mockFetchOnce(200, ['plain text chunk']);
    const results = await svc.search(makeConnector(), 'q');
    expect(results).toEqual([{ title: '', content: 'plain text chunk' }]);
  });
});

describe('AiKbService.testConnector', () => {
  const svc = new AiKbService(ENV);

  it('reports success with the result count', async () => {
    mockFetchOnce(200, { results: [{ title: 'a', text: 'b' }] });
    const out = await svc.testConnector(makeConnector());
    expect(out.success).toBe(true);
    expect(out.message).toContain('1 result');
  });

  it('maps auth and reachability errors without throwing', async () => {
    mockFetchOnce(401, {});
    const auth = await svc.testConnector(makeConnector());
    expect(auth.success).toBe(false);
    expect(auth.message).toContain('Authentication failed');

    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error('fetch failed'),
    );
    const unreachable = await svc.testConnector(makeConnector());
    expect(unreachable.success).toBe(false);
    expect(unreachable.message).toContain('Cannot reach');
  });
});
