import { BadRequestException } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';

const AUTH_USER = { id: 'admin-1', role: 'admin' } as any;
const TARGET = { id: 'u1', name: 'Ann', email: 'ann@x.com', role: 'member' };

/**
 * Fake transaction runner: `deleteUser` builds its deletes with the kysely
 * query builder, so the trx only has to record what was asked of it.
 */
function makeTrx() {
  const deleted: string[] = [];
  const trx: any = {
    deleteFrom: (table: string) => {
      deleted.push(table);
      return { where: () => ({ execute: async () => undefined }) };
    },
  };
  return { trx, deleted };
}

function makeService(overrides: Record<string, any> = {}) {
  const { trx, deleted } = makeTrx();

  const deps = {
    userRepo: {
      findById: jest.fn().mockResolvedValue({ ...TARGET }),
      roleCountByWorkspaceId: jest.fn().mockResolvedValue(2),
      updateUser: jest.fn().mockResolvedValue(undefined),
    },
    spaceMemberRepo: {
      findSoleAdminSpaces: jest.fn().mockResolvedValue([]),
    },
    shareRepo: {
      deleteByCreatorId: jest.fn().mockResolvedValue([]),
    },
    watcherRepo: { deleteByUserAndWorkspace: jest.fn() },
    favoriteRepo: { deleteByUserAndWorkspace: jest.fn() },
    userSessionRepo: { revokeByUserId: jest.fn() },
    auditService: { log: jest.fn() },
    attachmentQueue: { add: jest.fn() },
    db: { transaction: () => ({ execute: (cb: any) => cb(trx) }) },
    ...overrides,
  };

  const service = new WorkspaceService(
    null as any, // workspaceRepo
    null as any, // spaceService
    null as any, // spaceMemberService
    null as any, // groupRepo
    null as any, // groupUserRepo
    deps.userRepo as any,
    null as any, // environmentService
    null as any, // domainService
    null as any, // licenseCheckService
    deps.shareRepo as any,
    deps.spaceMemberRepo as any,
    deps.watcherRepo as any,
    deps.favoriteRepo as any,
    deps.db as any,
    deps.attachmentQueue as any,
    null as any, // billingQueue
    null as any, // aiQueue
    deps.auditService as any,
    deps.userSessionRepo as any,
  );

  return { service, deps, deleted };
}

describe('WorkspaceService.deleteUser', () => {
  it('refuses when the user is the only admin of a space, naming the spaces', async () => {
    const { service, deps } = makeService({
      spaceMemberRepo: {
        findSoleAdminSpaces: jest
          .fn()
          .mockResolvedValue([
            { id: 's1', name: 'Ann notes', slug: 'ann-notes' },
            { id: 's2', name: 'Design', slug: 'design' },
          ]),
      },
    });

    await expect(service.deleteUser(AUTH_USER, 'u1', 'ws-1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.deleteUser(AUTH_USER, 'u1', 'ws-1')).rejects.toThrow(
      /Ann notes, Design/,
    );
    // Nothing may be touched: the deletion has to stay fully reversible by
    // simply not having happened.
    expect(deps.userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('proceeds when every space the user administers has another admin', async () => {
    const { service, deps, deleted } = makeService();

    await service.deleteUser(AUTH_USER, 'u1', 'ws-1');

    expect(deps.userRepo.updateUser).toHaveBeenCalled();
    expect(deleted).toContain('spaceMembers');
  });

  it('revokes the public links the deleted user created', async () => {
    const { service, deps } = makeService({
      shareRepo: {
        deleteByCreatorId: jest.fn().mockResolvedValue(['share-1', 'share-2']),
      },
    });

    await service.deleteUser(AUTH_USER, 'u1', 'ws-1');

    expect(deps.shareRepo.deleteByCreatorId).toHaveBeenCalledWith(
      'u1',
      'ws-1',
      expect.anything(),
    );
    expect(deps.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { revokedShareCount: 2 },
      }),
    );
  });
});
