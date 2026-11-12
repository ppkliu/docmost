import { buildApiAccessEntry, summarizeRequestBody } from './api-access-log.service';

const KEY = '01a142bb-76f0-75aa-8398-73cc7527473f';
const OWNER = '01a0411c-bb47-7354-aab5-4e2f604acf36';
const WS = '01a03f2f-1fa4-49b0-a084-cafcb1c6d277';
const USER = '01a15741-e2e2-7585-8af4-b1db4a2c3e92';

describe('summarizeRequestBody', () => {
  it('keeps ids and roles, drops content and secrets', () => {
    expect(
      summarizeRequestBody({
        spaceId: USER, userIds: ['a', 'b'], role: 'writer',
        content: 'long page body', token: 'x', password: 'p', key: 'k', nested: { a: 1 },
      }),
    ).toEqual({ spaceId: USER, userIds: ['a', 'b'], role: 'writer' });
  });

  it('caps long arrays and records the real length', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const out = summarizeRequestBody({ userIds: ids }) as any;
    expect(out.userIds).toHaveLength(100);
    expect(out.userIdsCount).toBe(150);
  });

  it('ignores non-object bodies', () => {
    expect(summarizeRequestBody(undefined)).toBeNull();
    expect(summarizeRequestBody('text')).toBeNull();
    expect(summarizeRequestBody(Buffer.from('x'))).toBeNull();
    expect(summarizeRequestBody([1, 2])).toBeNull();
    expect(summarizeRequestBody({ content: 'only content' })).toBeNull();
  });
});

describe('buildApiAccessEntry', () => {
  const request = (raw: any, extra: any = {}) => ({
    raw: { workspaceId: WS, ...raw },
    method: 'post',
    url: '/api/spaces/members/add?token=secret',
    ip: '10.1.2.3',
    headers: { 'x-forwarded-for': '10.1.2.3, 100.19.8.25', 'user-agent': 'python-requests/2.31' },
    body: { spaceId: USER, userIds: ['a'], role: 'writer' },
    user: { user: { id: USER } },
    ...extra,
  });

  it('skips requests that did not use an API key', () => {
    expect(buildApiAccessEntry(request({}), { statusCode: 200 })).toBeNull();
    expect(buildApiAccessEntry(request({ authType: 'session' }), { statusCode: 200 })).toBeNull();
  });

  it('records key, owner, effective user, source and action', () => {
    const entry = buildApiAccessEntry(
      request({ authType: 'api_key', apiKeyId: KEY, apiKeyName: 'fll_key', apiKeyOwnerId: OWNER, impersonatorId: OWNER, onBehalfOf: 'm@x.com' }),
      { statusCode: 200, elapsedTime: 12.6 },
    );
    expect(entry).toEqual({
      workspaceId: WS, apiKeyId: KEY, apiKeyName: 'fll_key', keyOwnerId: OWNER, userId: USER,
      impersonatorId: OWNER, onBehalfOf: 'm@x.com',
      method: 'POST', path: '/api/spaces/members/add', statusCode: 200, durationMs: 13,
      ipAddress: '10.1.2.3', clientIp: '10.1.2.3', forwardedFor: '10.1.2.3, 100.19.8.25', userAgent: 'python-requests/2.31',
      requestSummary: { spaceId: USER, userIds: ['a'], role: 'writer' },
    });
  });

  it('prefers the chain the edge proxy passed as X-Forwarded-For-Claimed', () => {
    const entry = buildApiAccessEntry(
      request({ authType: 'api_key' }, {
        headers: { 'x-forwarded-for': '100.19.8.25', 'x-forwarded-for-claimed': '10.20.30.40, 100.19.8.25' },
      }),
      { statusCode: 200 },
    );
    expect(entry?.forwardedFor).toBe('10.20.30.40, 100.19.8.25');
    // the end user's IP is the leftmost claimed entry; ipAddress stays the proxy
    expect(entry?.clientIp).toBe('10.20.30.40');
    expect(entry?.ipAddress).toBe('10.1.2.3');
  });

  it('still records a rejected key (no user yet) and drops non-uuid ids', () => {
    const entry = buildApiAccessEntry(
      request({ authType: 'api_key', apiKeyId: 'not-a-uuid' }, { user: undefined }),
      { statusCode: 401 },
    );
    expect(entry?.apiKeyId).toBeNull();
    expect(entry?.apiKeyName).toBeNull();
    expect(entry?.userId).toBeNull();
    expect(entry?.statusCode).toBe(401);
    expect(entry?.durationMs).toBeNull();
  });
});
