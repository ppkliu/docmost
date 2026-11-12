import { applyApiKeyIdentity } from './audit-actor.interceptor';
import { contextMetadata } from '../../integrations/audit/audit.service';

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
    applyApiKeyIdentity(ctx, { authType: 'api_key', apiKeyId: 'k1', apiKeyOwnerId: 'owner', impersonatorId: 'owner' });
    expect(ctx).toMatchObject({ actorType: 'api_key', apiKeyId: 'k1', apiKeyOwnerId: 'owner', impersonatorId: 'owner' });
  });
});

describe('contextMetadata', () => {
  it('adds only the fields that are present', () => {
    expect(contextMetadata({ workspaceId: 'ws' })).toEqual({});
    expect(
      contextMetadata({ workspaceId: 'ws', userAgent: 'curl/8', forwardedFor: '1.2.3.4', apiKeyId: 'k1', apiKeyOwnerId: 'o' }),
    ).toEqual({ userAgent: 'curl/8', forwardedFor: '1.2.3.4', apiKeyId: 'k1', apiKeyOwnerId: 'o' });
  });
});
