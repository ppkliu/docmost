import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { dbOrTx } from '@docmost/db/utils';
import { sql } from 'kysely';
import {
  InsertableSpaceMember,
  SpaceMember,
  UpdatableSpaceMember,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '../../pagination/pagination-options';
import { MemberInfo, UserSpaceRole } from './types';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { GroupRepo } from '@docmost/db/repos/group/group.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { withCache } from '../../../common/helpers/with-cache';
import {
  CacheKey,
  PERMISSION_CACHE_TTL_MS,
} from '../../../common/helpers/cache-keys';

@Injectable()
export class SpaceMemberRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly groupRepo: GroupRepo,
    private readonly spaceRepo: SpaceRepo,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async insertSpaceMember(
    insertableSpaceMember: InsertableSpaceMember,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .insertInto('spaceMembers')
      .values(insertableSpaceMember)
      .returningAll()
      .execute();
  }

  async updateSpaceMember(
    updatableSpaceMember: UpdatableSpaceMember,
    spaceMemberId: string,
    spaceId: string,
  ): Promise<void> {
    await this.db
      .updateTable('spaceMembers')
      .set(updatableSpaceMember)
      .where('id', '=', spaceMemberId)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  async getSpaceMemberByTypeId(
    spaceId: string,
    opts: {
      userId?: string;
      groupId?: string;
    },
    trx?: KyselyTransaction,
  ): Promise<SpaceMember> {
    const db = dbOrTx(this.db, trx);
    let query = db
      .selectFrom('spaceMembers')
      .selectAll()
      .where('spaceId', '=', spaceId);
    if (opts.userId) {
      query = query.where('userId', '=', opts.userId);
    } else if (opts.groupId) {
      query = query.where('groupId', '=', opts.groupId);
    } else {
      throw new BadRequestException('Please provide a userId or groupId');
    }
    return query.executeTakeFirst();
  }

  async removeSpaceMemberById(
    memberId: string,
    spaceId: string,
    opts?: { trx?: KyselyTransaction },
  ): Promise<void> {
    const { trx } = opts;
    const db = dbOrTx(this.db, trx);
    await db
      .deleteFrom('spaceMembers')
      .where('id', '=', memberId)
      .where('spaceId', '=', spaceId)
      .execute();
  }

  /**
   * Spaces in this workspace whose ONLY admin member row is this user.
   *
   * Exists because `deleteUser` deletes space memberships in bulk and so walks
   * straight past `SpaceMemberService.validateLastAdmin`. Losing the last admin
   * leaves a space nobody can administer: space abilities are resolved purely
   * from `space_members` (see SpaceAbilityFactory), so not even a workspace
   * owner can add themselves back through the API.
   *
   * Counts member *rows*, matching `roleCountBySpaceId` — an admin group with
   * zero users still counts as an admin, same as the existing guard.
   */
  async findSoleAdminSpaces(
    userId: string,
    workspaceId: string,
  ): Promise<{ id: string; name: string; slug: string }[]> {
    const result = await sql<{ id: string; name: string; slug: string }>`
      SELECT s.id, s.name, s.slug
        FROM spaces s
        JOIN space_members sm ON sm.space_id = s.id AND sm.role = ${SpaceRole.ADMIN}
       WHERE s.workspace_id = ${workspaceId}
         AND s.deleted_at IS NULL
       GROUP BY s.id, s.name, s.slug
      HAVING count(*) = 1 AND bool_or(sm.user_id = ${userId})
       ORDER BY s.name
    `.execute(this.db);

    return result.rows;
  }

  /**
   * Groups that still grant this user access to a space after their direct
   * membership is gone. Removing a `space_members` row is not the same as
   * revoking access — `getUserSpaceRoles` unions direct and group-derived
   * roles, so the member list can say "removed" while the door stays open.
   */
  async getResidualAccessGroups(
    userId: string,
    spaceId: string,
  ): Promise<{ id: string; name: string; role: string }[]> {
    return this.db
      .selectFrom('spaceMembers')
      .innerJoin('groups', 'groups.id', 'spaceMembers.groupId')
      .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
      .select([
        'groups.id as id',
        'groups.name as name',
        'spaceMembers.role as role',
      ])
      .where('spaceMembers.spaceId', '=', spaceId)
      .where('groupUsers.userId', '=', userId)
      .execute();
  }

  /** Drop the cached space roles so a revocation takes effect now, not in 5s. */
  async invalidateUserSpaceRoles(
    userIds: string[],
    spaceId: string,
  ): Promise<void> {
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          await this.cacheManager.del(CacheKey.SPACE_ROLES(userId, spaceId));
        } catch (err) {
          // A cache that refuses to forget is not worth failing the removal
          // over: the entry expires on its own within PERMISSION_CACHE_TTL_MS.
          console.warn(
            `[invalidateUserSpaceRoles] del failed for ${userId}:${spaceId}`,
            err,
          );
        }
      }),
    );
  }

  async roleCountBySpaceId(role: string, spaceId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('spaceMembers')
      .select((eb) => eb.fn.count('role').as('count'))
      .where('role', '=', role)
      .where('spaceId', '=', spaceId)
      .executeTakeFirst();

    return count as number;
  }

  async getSpaceMembersPaginated(
    spaceId: string,
    pagination: PaginationOptions,
  ) {
    let baseQuery = this.db
      .selectFrom('spaceMembers')
      .leftJoin('users', 'users.id', 'spaceMembers.userId')
      .leftJoin('groups', 'groups.id', 'spaceMembers.groupId')
      .select([
        'spaceMembers.id as id',
        'users.id as userId',
        'users.name as userName',
        'users.avatarUrl as userAvatarUrl',
        'users.email as userEmail',
        'groups.id as groupId',
        'groups.name as groupName',
        'groups.isDefault as groupIsDefault',
        'spaceMembers.role',
        'spaceMembers.createdAt',
      ])
      .select((eb) => this.groupRepo.withMemberCount(eb))
      .select(
        sql<number>`case when groups.id is not null then 1 else 0 end`.as(
          'isGroup',
        ),
      )
      .select(
        sql<number>`case "space_members"."role" when 'admin' then 1 when 'writer' then 2 when 'reader' then 3 else 4 end`.as(
          'roleOrder',
        ),
      )
      .select(sql<string>`coalesce(users.name, groups.name)`.as('memberName'))
      .where('spaceId', '=', spaceId);

    if (pagination.query) {
      baseQuery = baseQuery.where((eb) =>
        eb(
          sql`f_unaccent(users.name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        )
          .or(
            sql`users.email`,
            'ilike',
            sql`f_unaccent(${'%' + pagination.query + '%'})`,
          )
          .or(
            sql`f_unaccent(groups.name)`,
            'ilike',
            sql`f_unaccent(${'%' + pagination.query + '%'})`,
          ),
      );
    }

    const query = this.db.selectFrom(baseQuery.as('sub')).selectAll('sub');

    const result = await executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'sub.roleOrder', direction: 'asc', key: 'roleOrder' },
        { expression: 'sub.isGroup', direction: 'desc', key: 'isGroup' },
        { expression: 'sub.memberName', direction: 'asc', key: 'memberName' },
        { expression: 'sub.id', direction: 'asc', key: 'id' },
      ],
      parseCursor: (cursor) => ({
        roleOrder: parseInt(cursor.roleOrder, 10),
        isGroup: parseInt(cursor.isGroup, 10),
        memberName: cursor.memberName,
        id: cursor.id,
      }),
    });

    let memberInfo: MemberInfo;

    const members = result.items.map((member) => {
      if (member.userId) {
        memberInfo = {
          id: member.userId,
          name: member.userName,
          email: member.userEmail,
          avatarUrl: member.userAvatarUrl,
          type: 'user',
        };
      } else if (member.groupId) {
        memberInfo = {
          id: member.groupId,
          name: member.groupName,
          memberCount: member.memberCount as number,
          isDefault: member.groupIsDefault,
          type: 'group',
        };
      }

      return {
        ...memberInfo,
        role: member.role,
        createdAt: member.createdAt,
      };
    });

    result.items = members as any;

    return result;
  }

  /*
   * we want to get a user's role in a space.
   * they user can be a member either directly or via a group
   * we will pass the user id and space id to return the user's roles
   * if the user is a member of the space via multiple groups
   * if the user has no space permission it should return an empty array,
   * maybe we should throw an exception?
   */
  async getUserSpaceRoles(
    userId: string,
    spaceId: string,
  ): Promise<UserSpaceRole[]> {
    return withCache(
      this.cacheManager,
      CacheKey.SPACE_ROLES(userId, spaceId),
      PERMISSION_CACHE_TTL_MS,
      async () => {
        const roles = await this.db
          .selectFrom('spaceMembers')
          .select(['userId', 'role'])
          .where('userId', '=', userId)
          .where('spaceId', '=', spaceId)
          .unionAll(
            this.db
              .selectFrom('spaceMembers')
              .innerJoin(
                'groupUsers',
                'groupUsers.groupId',
                'spaceMembers.groupId',
              )
              .select(['groupUsers.userId', 'spaceMembers.role'])
              .where('groupUsers.userId', '=', userId)
              .where('spaceMembers.spaceId', '=', spaceId),
          )
          .execute();

        if (!roles || roles.length === 0) {
          return undefined;
        }
        return roles;
      },
    );
  }

  async getUserIdsWithSpaceAccess(
    userIds: string[],
    spaceId: string,
  ): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const rows = await this.db
      .selectFrom('spaceMembers')
      .select('userId')
      .where('userId', 'in', userIds)
      .where('spaceId', '=', spaceId)
      .unionAll(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
          .select('groupUsers.userId')
          .where('groupUsers.userId', 'in', userIds)
          .where('spaceMembers.spaceId', '=', spaceId),
      )
      .execute();

    return new Set(rows.map((r) => r.userId));
  }

  async getSpaceIdsByGroupId(groupId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('spaceMembers')
      .select('spaceId')
      .where('groupId', '=', groupId)
      .execute();

    return rows.map((r) => r.spaceId);
  }

  getUserSpaceIdsQuery(userId: string) {
    return this.db
      .selectFrom('spaceMembers')
      .innerJoin('spaces', 'spaces.id', 'spaceMembers.spaceId')
      .select('spaces.id')
      .where('userId', '=', userId)
      .union(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin('groupUsers', 'groupUsers.groupId', 'spaceMembers.groupId')
          .innerJoin('spaces', 'spaces.id', 'spaceMembers.spaceId')
          .select('spaces.id')
          .where('groupUsers.userId', '=', userId),
      );
  }

  async getUserSpaceIds(userId: string): Promise<string[]> {
    const membership = await this.getUserSpaceIdsQuery(userId).execute();
    return membership.map((space) => space.id);
  }

  async getUserRolesForSpaces(
    userId: string,
    spaceIds: string[],
  ): Promise<{ spaceId: string; role: string }[]> {
    if (spaceIds.length === 0) return [];

    return this.db
      .selectFrom('spaceMembers')
      .select(['spaceId', 'role'])
      .where('userId', '=', userId)
      .where('spaceId', 'in', spaceIds)
      .unionAll(
        this.db
          .selectFrom('spaceMembers')
          .innerJoin(
            'groupUsers',
            'groupUsers.groupId',
            'spaceMembers.groupId',
          )
          .select(['spaceMembers.spaceId', 'spaceMembers.role'])
          .where('groupUsers.userId', '=', userId)
          .where('spaceMembers.spaceId', 'in', spaceIds),
      )
      .execute();
  }

  async getUserSpaces(userId: string, pagination: PaginationOptions) {
    let query = this.db
      .selectFrom('spaces')
      .selectAll()
      .select((eb) => [this.spaceRepo.withMemberCount(eb)])
      .where('id', 'in', this.getUserSpaceIdsQuery(userId));

    if (pagination.query) {
      query = query.where((eb) =>
        eb(
          sql`f_unaccent(name)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ).or(
          sql`f_unaccent(description)`,
          'ilike',
          sql`f_unaccent(${'%' + pagination.query + '%'})`,
        ),
      );
    }

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      fields: [
        { expression: 'name', direction: 'asc' },
        { expression: 'id', direction: 'asc' },
      ],
      parseCursor: (cursor) => ({ name: cursor.name, id: cursor.id }),
    });
  }
}
