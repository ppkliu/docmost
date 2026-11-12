import { ForbiddenException } from '@nestjs/common';
import { RejectApiKeyAuthGuard } from './reject-api-key-auth.guard';

const ctx = (raw: any) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ raw }) }) }) as any;

describe('RejectApiKeyAuthGuard', () => {
  const guard = new RejectApiKeyAuthGuard();

  it('lets browser sessions manage keys', () => {
    expect(guard.canActivate(ctx({}))).toBe(true);
  });

  it('refuses API-key requests, so a key cannot mint or list keys', () => {
    expect(() => guard.canActivate(ctx({ authType: 'api_key' }))).toThrow(ForbiddenException);
  });
});
