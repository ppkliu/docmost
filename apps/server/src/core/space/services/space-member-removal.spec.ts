import { SpaceMemberService } from './space-member.service';

const SPACE = { id: 'space-1', name: 'Engineering' };

function makeService(overrides: Record<string, any> = {}) {
  const deps = {
    spaceMemberRepo: {
      getSpaceMemberByTypeId: jest
        .fn()
        .mockResolvedValue({ id: 'sm-1', userId: 'u1', role: 'writer' }),
      removeSpaceMemberById: jest.fn().mockResolvedValue(undefined),
      roleCountBySpaceId: jest.fn().mockResolvedValue(2),
      getResidualAccessGroups: jest.fn().mockResolvedValue([]),
      invalidateUserSpaceRoles: jest.fn().mockResolvedValue(undefined),
    },
    shareRepo: { countBySpaceAndCreator: jest.fn().mockResolvedValue(0) },
    groupUserRepo: { getUserIdsByGroupId: jest.fn().mockResolvedValue([]) },
    spaceRepo: { findById: jest.fn().mockResolvedValue({ ...SPACE }) },
    watcherRepo: {
      deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
    },
    favoriteRepo: {
      deleteByUsersWithoutSpaceAccess: jest.fn().mockResolvedValue(undefined),
    },
    db: { transaction: () => ({ execute: (cb: any) => cb({}) }) },
    auditService: { log: jest.fn() },
    ...overrides,
  };

  const service = new SpaceMemberService(
    deps.spaceMemberRepo as any,
    deps.shareRepo as any,
    deps.groupUserRepo as any,
    deps.spaceRepo as any,
    deps.watcherRepo as any,
    deps.favoriteRepo as any,
    deps.db as any,
    deps.auditService as any,
  );

  return { service, deps };
}

describe('SpaceMemberService.removeMemberFromSpace', () => {
  it('reports the groups that still let the user in', async () => {
    const { service } = makeService({
      spaceMemberRepo: {
        getSpaceMemberByTypeId: jest
          .fn()
          .mockResolvedValue({ id: 'sm-1', userId: 'u1', role: 'writer' }),
        removeSpaceMemberById: jest.fn().mockResolvedValue(undefined),
        roleCountBySpaceId: jest.fn().mockResolvedValue(2),
        getResidualAccessGroups: jest
          .fn()
          .mockResolvedValue([{ id: 'g1', name: 'Everyone', role: 'reader' }]),
        invalidateUserSpaceRoles: jest.fn().mockResolvedValue(undefined),
      },
    });

    const result = await service.removeMemberFromSpace(
      { spaceId: 'space-1', userId: 'u1' } as any,
      'ws-1',
    );

    expect(result.residualAccessGroups).toEqual([
      { id: 'g1', name: 'Everyone', role: 'reader' },
    ]);
  });

  it('reports the public links the user created in this space', async () => {
    const { service } = makeService({
      shareRepo: { countBySpaceAndCreator: jest.fn().mockResolvedValue(3) },
    });

    const result = await service.removeMemberFromSpace(
      { spaceId: 'space-1', userId: 'u1' } as any,
      'ws-1',
    );

    expect(result.sharesCreatedHere).toBe(3);
  });

  it('drops the cached space roles so the revocation is not delayed', async () => {
    const { service, deps } = makeService();

    await service.removeMemberFromSpace(
      { spaceId: 'space-1', userId: 'u1' } as any,
      'ws-1',
    );

    expect(deps.spaceMemberRepo.invalidateUserSpaceRoles).toHaveBeenCalledWith(
      ['u1'],
      'space-1',
    );
  });

  it('skips per-user reporting when a group is removed', async () => {
    const { service, deps } = makeService({
      spaceMemberRepo: {
        getSpaceMemberByTypeId: jest
          .fn()
          .mockResolvedValue({ id: 'sm-2', groupId: 'g1', role: 'writer' }),
        removeSpaceMemberById: jest.fn().mockResolvedValue(undefined),
        roleCountBySpaceId: jest.fn().mockResolvedValue(2),
        getResidualAccessGroups: jest.fn(),
        invalidateUserSpaceRoles: jest.fn().mockResolvedValue(undefined),
      },
      groupUserRepo: {
        getUserIdsByGroupId: jest.fn().mockResolvedValue(['u1', 'u2']),
      },
    });

    const result = await service.removeMemberFromSpace(
      { spaceId: 'space-1', groupId: 'g1' } as any,
      'ws-1',
    );

    expect(result).toEqual({ residualAccessGroups: [], sharesCreatedHere: 0 });
    expect(deps.spaceMemberRepo.getResidualAccessGroups).not.toHaveBeenCalled();
    // Every user who lost access through the group must lose the cached role.
    expect(deps.spaceMemberRepo.invalidateUserSpaceRoles).toHaveBeenCalledWith(
      ['u1', 'u2'],
      'space-1',
    );
  });
});
