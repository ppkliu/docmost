import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import {
  QueueJob,
  QueueName,
} from '../../../integrations/queue/constants';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { Page, User } from '@docmost/db/types/entity.types';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  AddPagePermissionDto,
  PagePermissionRole,
  RemovePagePermissionDto,
  UpdatePagePermissionRoleDto,
} from '../dto/page-permission.dto';

export interface PageRestrictionInfo {
  restrictionId?: string;
  hasDirectRestriction: boolean;
  hasInheritedRestriction: boolean;
  inheritedFrom?: { id: string; slugId: string; title: string };
  userAccess: { canView: boolean; canEdit: boolean; canManage: boolean };
}

/**
 * Management layer for page-level permissions (restrict / permission CRUD).
 * Enforcement lives in PageAccessService + PagePermissionRepo (already wired
 * across pages, search, export, notifications); this service only mutates the
 * page_access / page_permissions records behind the client share modal.
 *
 * Manage rules: space admins always manage (lockout recovery); otherwise a
 * restricted page is managed by writers on its nearest restriction, and an
 * unrestricted page by anyone with space-level page-manage rights.
 */
@Injectable()
export class PagePermissionService {
  private readonly logger = new Logger(PagePermissionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageRepo: PageRepo,
    private readonly userRepo: UserRepo,
    private readonly groupRepo: GroupRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  /**
   * K3.3/K4.2: restriction changes re-enqueue indexing for the affected
   * subtree — the indexer drops restricted pages from the retrieval store and
   * re-embeds them once unrestricted. Best-effort; never blocks the mutation.
   */
  private async reindexSubtree(page: Page): Promise<void> {
    try {
      const subtreeIds = await this.pagePermissionRepo.getRestrictedSubtreeIds(
        page.id,
      );
      const pageIds = subtreeIds.length > 0 ? subtreeIds : [page.id];
      await this.aiQueue.add(QueueJob.GENERATE_PAGE_EMBEDDINGS, {
        pageIds,
        workspaceId: page.workspaceId,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue re-index after restriction change on ${page.id}: ${(err as Error)?.message}`,
      );
    }
  }

  async getPageOrThrow(pageId: string, workspaceId: string): Promise<Page> {
    const page = await this.pageRepo.findById(pageId);
    if (!page || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    return page;
  }

  async getRestrictionInfo(
    page: Page,
    user: User,
  ): Promise<PageRestrictionInfo> {
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const level = await this.pagePermissionRepo.getUserPageAccessLevel(
      user.id,
      page.id,
    );

    let restrictionId: string | undefined;
    if (level.hasDirectRestriction) {
      const access = await this.pagePermissionRepo.findPageAccessByPageId(
        page.id,
      );
      restrictionId = access?.id;
    }

    let inheritedFrom: PageRestrictionInfo['inheritedFrom'];
    if (level.hasInheritedRestriction && page.parentPageId) {
      const ancestor = await this.pagePermissionRepo.findRestrictedAncestor(
        page.parentPageId,
      );
      if (ancestor) {
        const ancestorPage = await this.pageRepo.findById(ancestor.pageId);
        if (ancestorPage) {
          inheritedFrom = {
            id: ancestorPage.id,
            slugId: ancestorPage.slugId,
            title: ancestorPage.title ?? '',
          };
        }
      }
    }

    const isSpaceAdmin = ability.can(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    const spaceCanManagePage = ability.can(
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Page,
    );

    return {
      restrictionId,
      hasDirectRestriction: level.hasDirectRestriction,
      hasInheritedRestriction: level.hasInheritedRestriction,
      inheritedFrom,
      userAccess: {
        canView: level.hasAnyRestriction ? level.canAccess : true,
        canEdit: level.hasAnyRestriction ? level.canEdit : spaceCanManagePage,
        canManage:
          isSpaceAdmin ||
          (level.hasAnyRestriction ? level.canEdit : spaceCanManagePage),
      },
    };
  }

  private async assertCanManage(page: Page, user: User): Promise<void> {
    const info = await this.getRestrictionInfo(page, user);
    if (!info.userAccess.canManage) {
      throw new ForbiddenException(
        'You do not have permission to manage access for this page',
      );
    }
  }

  /**
   * Restricts a page. Idempotent. The acting user is seeded as the first
   * writer so the page is never left without a manager.
   */
  async restrict(page: Page, user: User): Promise<void> {
    await this.assertCanManage(page, user);

    const existing = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (existing) return;

    await executeTx(this.db, async (trx) => {
      const access = await this.pagePermissionRepo.insertPageAccess(
        {
          pageId: page.id,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
          accessLevel: 'restricted',
          creatorId: user.id,
        },
        trx,
      );
      await this.pagePermissionRepo.insertPagePermissions(
        [
          {
            pageAccessId: access.id,
            userId: user.id,
            role: 'writer',
            addedById: user.id,
          },
        ],
        trx,
      );
    });

    // subtree is restricted now; the indexer evicts it from retrieval
    await this.reindexSubtree(page);
  }

  /** Removes the restriction (and cascades its permission rows). */
  async unrestrict(page: Page, user: User): Promise<void> {
    await this.assertCanManage(page, user);
    // compute the affected subtree while the restriction still exists
    const subtreeIds = await this.pagePermissionRepo.getRestrictedSubtreeIds(
      page.id,
    );
    await this.pagePermissionRepo.deletePageAccess(page.id);

    try {
      await this.aiQueue.add(QueueJob.GENERATE_PAGE_EMBEDDINGS, {
        pageIds: subtreeIds.length > 0 ? subtreeIds : [page.id],
        workspaceId: page.workspaceId,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to enqueue re-index after unrestrict on ${page.id}: ${(err as Error)?.message}`,
      );
    }
  }

  async addPermissions(
    page: Page,
    user: User,
    dto: AddPagePermissionDto,
  ): Promise<void> {
    const access = await this.requireRestriction(page);
    await this.assertCanManage(page, user);

    if (!dto.userIds?.length && !dto.groupIds?.length) {
      throw new BadRequestException('No users or groups provided');
    }

    for (const userId of dto.userIds ?? []) {
      const member = await this.userRepo.findById(userId, page.workspaceId);
      if (!member) {
        throw new BadRequestException(`User not in workspace: ${userId}`);
      }
      const existing =
        await this.pagePermissionRepo.findPagePermissionByUserId(
          access.id,
          userId,
        );
      if (existing) {
        // re-adding adjusts the role instead of erroring
        await this.pagePermissionRepo.updatePagePermissionRole(
          access.id,
          dto.role,
          { userId },
        );
        continue;
      }
      await this.pagePermissionRepo.insertPagePermissions([
        {
          pageAccessId: access.id,
          userId,
          role: dto.role,
          addedById: user.id,
        },
      ]);
    }

    for (const groupId of dto.groupIds ?? []) {
      const group = await this.groupRepo.findById(groupId, page.workspaceId);
      if (!group) {
        throw new BadRequestException(`Group not in workspace: ${groupId}`);
      }
      const existing =
        await this.pagePermissionRepo.findPagePermissionByGroupId(
          access.id,
          groupId,
        );
      if (existing) {
        await this.pagePermissionRepo.updatePagePermissionRole(
          access.id,
          dto.role,
          { groupId },
        );
        continue;
      }
      await this.pagePermissionRepo.insertPagePermissions([
        {
          pageAccessId: access.id,
          groupId,
          role: dto.role,
          addedById: user.id,
        },
      ]);
    }
  }

  async removePermissions(
    page: Page,
    user: User,
    dto: RemovePagePermissionDto,
  ): Promise<void> {
    const access = await this.requireRestriction(page);
    await this.assertCanManage(page, user);

    if (!dto.userIds?.length && !dto.groupIds?.length) {
      throw new BadRequestException('No users or groups provided');
    }

    await this.assertWritersRemain(access.id, {
      removeUserIds: dto.userIds ?? [],
      removeGroupIds: dto.groupIds ?? [],
    });

    if (dto.userIds?.length) {
      await this.pagePermissionRepo.deletePagePermissionsByUserIds(
        access.id,
        dto.userIds,
      );
    }
    if (dto.groupIds?.length) {
      await this.pagePermissionRepo.deletePagePermissionsByGroupIds(
        access.id,
        dto.groupIds,
      );
    }
  }

  async updateRole(
    page: Page,
    user: User,
    dto: UpdatePagePermissionRoleDto,
  ): Promise<void> {
    const access = await this.requireRestriction(page);
    await this.assertCanManage(page, user);

    if (!dto.userId && !dto.groupId) {
      throw new BadRequestException('A userId or groupId is required');
    }

    if (dto.role === 'reader') {
      await this.assertWritersRemain(access.id, {
        demoteUserId: dto.userId,
        demoteGroupId: dto.groupId,
      });
    }

    await this.pagePermissionRepo.updatePagePermissionRole(
      access.id,
      dto.role,
      { userId: dto.userId, groupId: dto.groupId },
    );
  }

  async listPermissions(page: Page, user: User, pagination: PaginationOptions) {
    // any space member who can view the page may see who has access
    const info = await this.getRestrictionInfo(page, user);
    if (!info.userAccess.canView) {
      throw new ForbiddenException();
    }
    const access = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!access) {
      return { items: [], meta: { hasNextPage: false, hasPrevPage: false } };
    }
    return this.pagePermissionRepo.getPagePermissionsPaginated(
      access.id,
      pagination,
    );
  }

  private async requireRestriction(page: Page) {
    const access = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!access) {
      throw new BadRequestException('Page is not restricted');
    }
    return access;
  }

  /**
   * A restricted page must always keep at least one writer, otherwise nobody
   * (except space admins) could manage or edit it.
   */
  private async assertWritersRemain(
    pageAccessId: string,
    change: {
      removeUserIds?: string[];
      removeGroupIds?: string[];
      demoteUserId?: string;
      demoteGroupId?: string;
    },
  ): Promise<void> {
    const total = await this.pagePermissionRepo.countWritersByPageAccessId(
      pageAccessId,
    );

    let removedWriters = 0;
    for (const userId of change.removeUserIds ?? []) {
      const perm = await this.pagePermissionRepo.findPagePermissionByUserId(
        pageAccessId,
        userId,
      );
      if (perm?.role === 'writer') removedWriters++;
    }
    for (const groupId of change.removeGroupIds ?? []) {
      const perm = await this.pagePermissionRepo.findPagePermissionByGroupId(
        pageAccessId,
        groupId,
      );
      if (perm?.role === 'writer') removedWriters++;
    }
    if (change.demoteUserId) {
      const perm = await this.pagePermissionRepo.findPagePermissionByUserId(
        pageAccessId,
        change.demoteUserId,
      );
      if (perm?.role === 'writer') removedWriters++;
    }
    if (change.demoteGroupId) {
      const perm = await this.pagePermissionRepo.findPagePermissionByGroupId(
        pageAccessId,
        change.demoteGroupId,
      );
      if (perm?.role === 'writer') removedWriters++;
    }

    if (removedWriters > 0 && total - removedWriters < 1) {
      throw new BadRequestException(
        'A restricted page must keep at least one writer',
      );
    }
  }
}
