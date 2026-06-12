import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as dbUtils from '@docmost/db/utils';
import { PagePermissionService } from './page-permission.service';

const PAGE = {
  id: 'page-1',
  spaceId: 'space-1',
  workspaceId: 'ws-1',
  parentPageId: null,
} as any;

function ability(rules: { admin?: boolean; managePage?: boolean; read?: boolean }) {
  return {
    can: (action: string, subject: string) => {
      if (subject === 'settings') return !!rules.admin;
      if (subject === 'page' && action === 'manage') return !!rules.managePage;
      if (subject === 'page' && action === 'read') return rules.read !== false;
      return false;
    },
    cannot(action: string, subject: string) {
      return !this.can(action, subject);
    },
  };
}

function makeService(overrides: Record<string, any> = {}) {
  const deps = {
    db: {},
    permRepo: {
      getUserPageAccessLevel: jest.fn().mockResolvedValue({
        hasDirectRestriction: false,
        hasInheritedRestriction: false,
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      }),
      findPageAccessByPageId: jest.fn().mockResolvedValue(undefined),
      findRestrictedAncestor: jest.fn().mockResolvedValue(undefined),
      insertPageAccess: jest.fn().mockResolvedValue({ id: 'access-1' }),
      insertPagePermissions: jest.fn().mockResolvedValue(undefined),
      deletePageAccess: jest.fn().mockResolvedValue(undefined),
      findPagePermissionByUserId: jest.fn().mockResolvedValue(undefined),
      findPagePermissionByGroupId: jest.fn().mockResolvedValue(undefined),
      updatePagePermissionRole: jest.fn().mockResolvedValue(undefined),
      deletePagePermissionsByUserIds: jest.fn().mockResolvedValue(undefined),
      deletePagePermissionsByGroupIds: jest.fn().mockResolvedValue(undefined),
      countWritersByPageAccessId: jest.fn().mockResolvedValue(2),
      getPagePermissionsPaginated: jest
        .fn()
        .mockResolvedValue({ items: [], meta: {} }),
      getRestrictedSubtreeIds: jest.fn().mockResolvedValue([]),
    },
    aiQueue: { add: jest.fn().mockResolvedValue(undefined) },
    pageRepo: { findById: jest.fn().mockResolvedValue(PAGE) },
    userRepo: { findById: jest.fn().mockResolvedValue({ id: 'u2' }) },
    groupRepo: { findById: jest.fn().mockResolvedValue({ id: 'g1' }) },
    spaceAbility: {
      createForUser: jest
        .fn()
        .mockResolvedValue(ability({ managePage: true })),
    },
    ...overrides,
  };

  const service = new PagePermissionService(
    deps.db as any,
    deps.permRepo as any,
    deps.pageRepo as any,
    deps.userRepo as any,
    deps.groupRepo as any,
    deps.spaceAbility as any,
    deps.aiQueue as any,
  );
  return { service, deps };
}

const USER = { id: 'u1' } as any;

describe('PagePermissionService.getRestrictionInfo', () => {
  it('reports manage rights from space page-manage when unrestricted', async () => {
    const { service } = makeService();
    const info = await service.getRestrictionInfo(PAGE, USER);
    expect(info.hasDirectRestriction).toBe(false);
    expect(info.userAccess).toEqual({
      canView: true,
      canEdit: true,
      canManage: true,
    });
  });

  it('uses page-level writer for manage rights when restricted', async () => {
    const { service, deps } = makeService();
    deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: true,
      hasInheritedRestriction: false,
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: false, // reader on the restriction
    });
    deps.permRepo.findPageAccessByPageId.mockResolvedValue({ id: 'access-1' });

    const info = await service.getRestrictionInfo(PAGE, USER);
    expect(info.restrictionId).toBe('access-1');
    expect(info.userAccess.canEdit).toBe(false);
    expect(info.userAccess.canManage).toBe(false);
  });

  it('lets space admins manage even when locked out (lockout recovery)', async () => {
    const { service, deps } = makeService({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue(ability({ admin: true })),
      },
    });
    deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: true,
      hasInheritedRestriction: false,
      hasAnyRestriction: true,
      canAccess: false,
      canEdit: false,
    });

    const info = await service.getRestrictionInfo(PAGE, USER);
    expect(info.userAccess.canView).toBe(false);
    expect(info.userAccess.canManage).toBe(true);
  });

  it('resolves the inherited-restriction ancestor for the banner', async () => {
    const page = { ...PAGE, parentPageId: 'parent-1' };
    const { service, deps } = makeService();
    deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: false,
      hasInheritedRestriction: true,
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });
    deps.permRepo.findRestrictedAncestor.mockResolvedValue({
      pageAccessId: 'access-9',
      pageId: 'ancestor-9',
      accessLevel: 'restricted',
      depth: 0,
    });
    deps.pageRepo.findById.mockResolvedValue({
      id: 'ancestor-9',
      slugId: 'slug-9',
      title: 'Parent',
    });

    const info = await service.getRestrictionInfo(page, USER);
    // searched from the parent so "nearest" is a strict ancestor
    expect(deps.permRepo.findRestrictedAncestor).toHaveBeenCalledWith(
      'parent-1',
    );
    expect(info.inheritedFrom).toEqual({
      id: 'ancestor-9',
      slugId: 'slug-9',
      title: 'Parent',
    });
  });

  it('rejects non-members of the space', async () => {
    const { service } = makeService({
      spaceAbility: {
        createForUser: jest
          .fn()
          .mockResolvedValue(ability({ read: false })),
      },
    });
    await expect(service.getRestrictionInfo(PAGE, USER)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('PagePermissionService.restrict', () => {
  it('creates the restriction and seeds the actor as writer', async () => {
    const { service, deps } = makeService();
    // bypass the kysely transaction wrapper; repo calls receive trx=undefined
    jest
      .spyOn(dbUtils, 'executeTx')
      .mockImplementation(async (_db: any, fn: any) => fn(undefined));

    await service.restrict(PAGE, USER);

    expect(deps.permRepo.insertPageAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'ws-1',
        accessLevel: 'restricted',
        creatorId: 'u1',
      }),
      undefined,
    );
    expect(deps.permRepo.insertPagePermissions).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          pageAccessId: 'access-1',
          userId: 'u1',
          role: 'writer',
        }),
      ],
      undefined,
    );
  });

  it('K3.3: re-enqueues subtree indexing on restrict and unrestrict', async () => {
    const { service, deps } = makeService();
    jest
      .spyOn(dbUtils, 'executeTx')
      .mockImplementation(async (_db: any, fn: any) => fn(undefined));
    deps.permRepo.getRestrictedSubtreeIds.mockResolvedValue(['page-1', 'child-1']);

    await service.restrict(PAGE, USER);
    expect(deps.aiQueue.add).toHaveBeenCalledWith(
      'generate-page-embeddings',
      { pageIds: ['page-1', 'child-1'], workspaceId: 'ws-1' },
    );

    // unrestrict: subtree computed BEFORE the restriction row is deleted
    deps.aiQueue.add.mockClear();
    deps.permRepo.findPageAccessByPageId.mockResolvedValue({ id: 'access-1' });
    deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: true,
      hasInheritedRestriction: false,
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });
    const callOrder: string[] = [];
    deps.permRepo.getRestrictedSubtreeIds.mockImplementation(async () => {
      callOrder.push('subtree');
      return ['page-1', 'child-1'];
    });
    deps.permRepo.deletePageAccess.mockImplementation(async () => {
      callOrder.push('delete');
    });

    await service.unrestrict(PAGE, USER);
    expect(callOrder).toEqual(['subtree', 'delete']);
    expect(deps.aiQueue.add).toHaveBeenCalledWith(
      'generate-page-embeddings',
      { pageIds: ['page-1', 'child-1'], workspaceId: 'ws-1' },
    );
  });

  it('is idempotent when already restricted', async () => {
    const { service, deps } = makeService();
    deps.permRepo.findPageAccessByPageId.mockResolvedValue({ id: 'access-1' });
    // restricted + actor is writer so canManage stays true
    deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: true,
      hasInheritedRestriction: false,
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true,
    });

    await service.restrict(PAGE, USER);
    expect(deps.permRepo.insertPageAccess).not.toHaveBeenCalled();
  });

  it('rejects users without manage rights', async () => {
    const { service } = makeService({
      spaceAbility: {
        createForUser: jest
          .fn()
          .mockResolvedValue(ability({ managePage: false })),
      },
    });
    await expect(service.restrict(PAGE, USER)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('PagePermissionService permission CRUD', () => {
  function restricted(overrides: Record<string, any> = {}) {
    const made = makeService(overrides);
    made.deps.permRepo.findPageAccessByPageId.mockResolvedValue({
      id: 'access-1',
    });
    made.deps.permRepo.getUserPageAccessLevel.mockResolvedValue({
      hasDirectRestriction: true,
      hasInheritedRestriction: false,
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: true, // actor is writer
    });
    return made;
  }

  it('adds user and group permissions, upserting existing ones', async () => {
    const { service, deps } = restricted();
    deps.permRepo.findPagePermissionByUserId.mockResolvedValue({
      id: 'perm-1',
      role: 'reader',
    });

    await service.addPermissions(PAGE, USER, {
      pageId: 'page-1',
      role: 'writer',
      userIds: ['u2'],
      groupIds: ['g1'],
    } as any);

    // existing user permission -> role update, not duplicate insert
    expect(deps.permRepo.updatePagePermissionRole).toHaveBeenCalledWith(
      'access-1',
      'writer',
      { userId: 'u2' },
    );
    // new group permission -> insert
    expect(deps.permRepo.insertPagePermissions).toHaveBeenCalledWith([
      expect.objectContaining({ groupId: 'g1', role: 'writer' }),
    ]);
  });

  it('rejects users outside the workspace', async () => {
    const { service, deps } = restricted();
    deps.userRepo.findById.mockResolvedValue(undefined);
    await expect(
      service.addPermissions(PAGE, USER, {
        pageId: 'page-1',
        role: 'reader',
        userIds: ['stranger'],
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to remove the last writer', async () => {
    const { service, deps } = restricted();
    deps.permRepo.countWritersByPageAccessId.mockResolvedValue(1);
    deps.permRepo.findPagePermissionByUserId.mockResolvedValue({
      id: 'perm-1',
      role: 'writer',
    });

    await expect(
      service.removePermissions(PAGE, USER, {
        pageId: 'page-1',
        userIds: ['u2'],
      } as any),
    ).rejects.toThrow('must keep at least one writer');
  });

  it('refuses to demote the last writer to reader', async () => {
    const { service, deps } = restricted();
    deps.permRepo.countWritersByPageAccessId.mockResolvedValue(1);
    deps.permRepo.findPagePermissionByUserId.mockResolvedValue({
      id: 'perm-1',
      role: 'writer',
    });

    await expect(
      service.updateRole(PAGE, USER, {
        pageId: 'page-1',
        role: 'reader',
        userId: 'u2',
      } as any),
    ).rejects.toThrow('must keep at least one writer');
  });

  it('requires the page to be restricted first', async () => {
    const { service } = makeService();
    await expect(
      service.addPermissions(PAGE, USER, {
        pageId: 'page-1',
        role: 'reader',
        userIds: ['u2'],
      } as any),
    ).rejects.toThrow('not restricted');
  });

  it('returns an empty list for unrestricted pages', async () => {
    const { service } = makeService();
    const result = await service.listPermissions(PAGE, USER, {} as any);
    expect(result.items).toEqual([]);
  });
});
