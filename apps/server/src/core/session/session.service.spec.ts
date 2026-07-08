import { SessionService } from './session.service';

function makeService(options: { auditIp?: string; nativeZone?: string } = {}) {
  const tokenService = {
    generateAccessToken: jest.fn().mockResolvedValue('token'),
  };
  const userSessionRepo = {
    insertSession: jest.fn().mockResolvedValue({ id: 'session-id' }),
  };
  const nativeZone = options.nativeZone ?? 'office';
  const environmentService = {
    getCookieExpiresIn: jest.fn().mockReturnValue(new Date('2030-01-01')),
    // Single owner of the login-zone decision (override wins, else native .env).
    getLoginNetworkZone: jest.fn((_source: string, opts: any = {}) =>
      opts.overrideZone === 'internal' || opts.overrideZone === 'office'
        ? opts.overrideZone
        : nativeZone,
    ),
  };
  const cls = {
    get: jest.fn().mockReturnValue({
      ipAddress: options.auditIp ?? '10.7.1.10',
      userAgent: 'Mozilla/5.0',
    }),
  };

  return {
    tokenService,
    userSessionRepo,
    environmentService,
    cls,
    service: new SessionService(
      tokenService as any,
      userSessionRepo as any,
      environmentService as any,
      cls as any,
    ),
  };
}

const user = {
  id: 'user-id',
  workspaceId: 'workspace-id',
} as any;

describe('SessionService', () => {
  describe('createSessionAndToken network zone metadata', () => {
    it('stores the explicit login zone when provided', async () => {
      const { service, userSessionRepo, environmentService } = makeService();

      await service.createSessionAndToken(user, { zone: 'internal' });

      expect(environmentService.getLoginNetworkZone).toHaveBeenCalledWith(
        'native',
        { overrideZone: 'internal' },
      );
      expect(userSessionRepo.insertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { zone: 'internal' },
        }),
      );
    });

    it('falls back to the configured native login zone', async () => {
      const { service, userSessionRepo, environmentService } = makeService({
        nativeZone: 'office',
      });

      await service.createSessionAndToken(user);

      expect(environmentService.getLoginNetworkZone).toHaveBeenCalledWith(
        'native',
        { overrideZone: undefined },
      );
      expect(userSessionRepo.insertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { zone: 'office' },
        }),
      );
    });

    it('can stamp native password login as internal for test deployments', async () => {
      const { service, userSessionRepo } = makeService({
        nativeZone: 'internal',
      });

      await service.createSessionAndToken(user);

      expect(userSessionRepo.insertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { zone: 'internal' },
        }),
      );
    });
  });

  // Login-zone echo (docmost-login-zone-echo-design §3): the method must return
  // the exact zone it stamped alongside the token, so callers echo the
  // authoritative value instead of recomputing it.
  describe('createSessionAndToken return shape', () => {
    it('returns both the token and the zone actually stamped (explicit override)', async () => {
      const { service } = makeService();

      const result = await service.createSessionAndToken(user, { zone: 'internal' });

      expect(result).toEqual({ token: 'token', zone: 'internal' });
    });

    it('returns the native login zone when no override is given', async () => {
      const { service } = makeService({ nativeZone: 'office' });

      const result = await service.createSessionAndToken(user);

      expect(result).toEqual({ token: 'token', zone: 'office' });
    });
  });
});
