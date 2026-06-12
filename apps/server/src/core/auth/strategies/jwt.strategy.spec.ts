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
