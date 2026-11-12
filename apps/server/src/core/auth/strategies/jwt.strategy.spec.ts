import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy, ON_BEHALF_OF_HEADER } from './jwt.strategy';

function makeStrategy(userRepoOverrides: Record<string, any> = {}) {
  const userRepo = {
    findById: jest.fn(),
    findByEmail: jest.fn().mockResolvedValue({
      id: 'member-1',
      email: 'member@test.local',
      role: 'member',
      deactivatedAt: null,
      deletedAt: null,
    }),
    ...userRepoOverrides,
  };
  const strategy = new JwtStrategy(
    userRepo as any,
    {} as any, // workspaceRepo
    {} as any, // userSessionRepo
    {} as any, // sessionActivityService
    { getAppSecret: () => 'test-secret' } as any,
    {} as any, // moduleRef
  );
  return { strategy, userRepo };
}

function makeReq(onBehalfOf?: string): {
  raw: { headers: Record<string, string>; impersonatorId?: string };
} {
  return {
    raw: {
      headers: onBehalfOf ? { [ON_BEHALF_OF_HEADER]: onBehalfOf } : {},
    },
  };
}

const workspace = { id: 'ws-1' };
const adminResult = {
  user: { id: 'admin-1', role: 'admin' },
  workspace,
};

describe('JwtStrategy on-behalf-of (H1 attribution)', () => {
  it('passes through when the header is absent', async () => {
    const { strategy, userRepo } = makeStrategy();
    const out = await (strategy as any).applyOnBehalfOf(
      makeReq(),
      adminResult,
    );
    expect(out).toBe(adminResult);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  it('swaps the identity for admin-owned keys and records the impersonator', async () => {
    const { strategy, userRepo } = makeStrategy();
    const req = makeReq('Member@Test.local');

    const out = await (strategy as any).applyOnBehalfOf(req, adminResult);

    expect(userRepo.findByEmail).toHaveBeenCalledWith(
      'member@test.local',
      'ws-1',
    );
    expect(out.user.id).toBe('member-1');
    expect(out.workspace).toBe(workspace);
    expect(req.raw.impersonatorId).toBe('admin-1');
  });

  it('allows owner-owned keys too', async () => {
    const { strategy } = makeStrategy();
    const out = await (strategy as any).applyOnBehalfOf(
      makeReq('member@test.local'),
      { user: { id: 'owner-1', role: 'owner' }, workspace },
    );
    expect(out.user.id).toBe('member-1');
  });

  it('rejects member-owned keys instead of silently mis-attributing', async () => {
    const { strategy, userRepo } = makeStrategy();
    await expect(
      (strategy as any).applyOnBehalfOf(makeReq('member@test.local'), {
        user: { id: 'member-9', role: 'member' },
        workspace,
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  it('rejects unknown or disabled target users', async () => {
    const unknown = makeStrategy({
      findByEmail: jest.fn().mockResolvedValue(undefined),
    });
    await expect(
      (unknown.strategy as any).applyOnBehalfOf(
        makeReq('ghost@test.local'),
        adminResult,
      ),
    ).rejects.toThrow(UnauthorizedException);

    const disabled = makeStrategy({
      findByEmail: jest.fn().mockResolvedValue({
        id: 'member-2',
        role: 'member',
        deactivatedAt: new Date(),
      }),
    });
    await expect(
      (disabled.strategy as any).applyOnBehalfOf(
        makeReq('member2@test.local'),
        adminResult,
      ),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('JwtStrategy API-key identity for audit / access log', () => {
  it('records the key owner even without on-behalf-of', async () => {
    const { strategy } = makeStrategy();
    const req: any = makeReq();
    await (strategy as any).applyOnBehalfOf(req, adminResult);
    expect(req.raw.apiKeyOwnerId).toBe('admin-1');
    expect(req.raw.impersonatorId).toBeUndefined();
    expect(req.raw.onBehalfOf).toBeUndefined();
  });

  it('keeps the owner and the requested target when acting on behalf of someone', async () => {
    const { strategy } = makeStrategy();
    const req: any = makeReq('member@test.local');
    await (strategy as any).applyOnBehalfOf(req, adminResult);
    expect(req.raw.apiKeyOwnerId).toBe('admin-1');
    expect(req.raw.impersonatorId).toBe('admin-1');
    expect(req.raw.onBehalfOf).toBe('member@test.local');
  });

  it('marks the key id before validating, so rejected keys are still traceable', async () => {
    const validateApiKey = jest.fn().mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const strategy = new JwtStrategy(
      {} as any, {} as any, {} as any, {} as any,
      { getAppSecret: () => 'test-secret' } as any,
      { get: () => ({ validateApiKey }) } as any,
    );
    const req: any = makeReq();
    await expect(
      (strategy as any).validateApiKey(req, { sub: 'u', workspaceId: 'ws-1', apiKeyId: 'key-1', type: 'api_key' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.raw.authType).toBe('api_key');
    expect(req.raw.apiKeyId).toBe('key-1');
  });
});

describe('JwtStrategy API-key name', () => {
  it('keeps the key name on the request and hands passport only user + workspace', async () => {
    const result = { user: { id: 'admin-1', role: 'admin' }, workspace, apiKey: { id: 'key-1', name: 'fll_key' } };
    const strategy = new JwtStrategy(
      {} as any, {} as any, {} as any, {} as any,
      { getAppSecret: () => 'test-secret' } as any,
      { get: () => ({ validateApiKey: jest.fn().mockResolvedValue(result) }) } as any,
    );
    const req: any = makeReq();
    const out = await (strategy as any).validateApiKey(req, { sub: 'admin-1', workspaceId: 'ws-1', apiKeyId: 'key-1', type: 'api_key' });
    expect(req.raw.apiKeyName).toBe('fll_key');
    expect(out).toEqual({ user: result.user, workspace });
  });
});
