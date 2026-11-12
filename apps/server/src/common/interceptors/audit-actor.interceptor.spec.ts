import { applyApiKeyIdentity } from './audit-actor.interceptor';
import { contextMetadata } from '../../integrations/audit/audit.service';
import { clientIpOf, forwardedForOf } from '../middlewares/audit-context.middleware';

const base = () => ({ workspaceId: 'ws', actorId: 'u', actorType: 'user' as const, ipAddress: null, userAgent: null });

describe('applyApiKeyIdentity', () => {
  it('leaves session requests as actorType user', () => {
    const ctx: any = base();
    applyApiKeyIdentity(ctx, { authType: undefined });
    expect(ctx.actorType).toBe('user');
    expect(ctx.apiKeyId).toBeUndefined();
  });

  it('marks API-key requests with the key and its owner', () => {
    const ctx: any = base();
    applyApiKeyIdentity(ctx, { authType: 'api_key', apiKeyId: 'k1', apiKeyName: 'fll_key', apiKeyOwnerId: 'owner', impersonatorId: 'owner' });
    expect(ctx).toMatchObject({ actorType: 'api_key', apiKeyId: 'k1', apiKeyName: 'fll_key', apiKeyOwnerId: 'owner', impersonatorId: 'owner' });
  });
});

describe('contextMetadata', () => {
  it('adds only the fields that are present', () => {
    expect(contextMetadata({ workspaceId: 'ws' })).toEqual({});
    expect(
      contextMetadata({ workspaceId: 'ws', userAgent: 'curl/8', forwardedFor: '1.2.3.4', clientIp: '1.2.3.4', apiKeyId: 'k1', apiKeyName: 'fll_key', apiKeyOwnerId: 'o' }),
    ).toEqual({ userAgent: 'curl/8', forwardedFor: '1.2.3.4', clientIp: '1.2.3.4', apiKeyId: 'k1', apiKeyName: 'fll_key', apiKeyOwnerId: 'o' });
  });
});

describe('forwardedForOf', () => {
  it('prefers the claimed chain from the edge proxy', () => {
    expect(forwardedForOf({ 'x-forwarded-for': '100.19.8.25', 'x-forwarded-for-claimed': '10.0.0.9, 100.19.8.25' }))
      .toBe('10.0.0.9, 100.19.8.25');
  });

  it('falls back to X-Forwarded-For, then null', () => {
    expect(forwardedForOf({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] })).toBe('1.1.1.1, 2.2.2.2');
    expect(forwardedForOf({ 'x-forwarded-for-claimed': '' })).toBeNull();
    expect(forwardedForOf({})).toBeNull();
  });
});

describe('clientIpOf', () => {
  it('takes the leftmost claimed address as the end user', () => {
    expect(clientIpOf({ 'x-forwarded-for-claimed': ' 10.0.0.9 , 100.19.8.25' }, '100.19.8.25')).toBe('10.0.0.9');
    expect(clientIpOf({ 'x-forwarded-for-claimed': '2001:db8::1, 100.19.8.25' }, '100.19.8.25')).toBe('2001:db8::1');
  });

  it('falls back to the connecting address when nothing usable was claimed', () => {
    expect(clientIpOf({}, '10.1.1.1')).toBe('10.1.1.1');
    expect(clientIpOf({ 'x-forwarded-for-claimed': 'unknown' }, '10.1.1.1')).toBe('10.1.1.1');
    expect(clientIpOf({ 'x-forwarded-for-claimed': '<script>' }, null)).toBeNull();
  });
});
