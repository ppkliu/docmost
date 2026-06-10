import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { AUDIT_SERVICE, IAuditService } from './audit.service';

class AuditLogParams extends PaginationOptions {
  event?: string;
  resourceType?: string;
  actorId?: string;
  spaceId?: string;
  startDate?: string;
  endDate?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('audit')
export class AuditController {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async getAuditLogs(
    @Body() dto: AuditLogParams,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.ensureCanManageAudit(user, workspace);

    let query = this.db
      .selectFrom('audit')
      .leftJoin('users as actor', 'actor.id', 'audit.actorId')
      .leftJoin('pages', 'pages.id', 'audit.resourceId')
      .leftJoin('spaces', 'spaces.id', 'audit.spaceId')
      .selectAll('audit')
      .select([
        'actor.id as actorUserId',
        'actor.name as actorName',
        'actor.email as actorEmail',
        'actor.avatarUrl as actorAvatarUrl',
        'pages.title as pageTitle',
        'pages.slugId as pageSlugId',
        'spaces.name as spaceName',
        'spaces.slug as spaceSlug',
      ])
      .where('audit.workspaceId', '=', workspace.id);

    if (dto.event) query = query.where('audit.event', '=', dto.event);
    if (dto.resourceType) {
      query = query.where('audit.resourceType', '=', dto.resourceType);
    }
    if (dto.actorId) query = query.where('audit.actorId', '=', dto.actorId);
    if (dto.spaceId) query = query.where('audit.spaceId', '=', dto.spaceId);
    if (dto.startDate) {
      query = query.where('audit.createdAt', '>=', new Date(dto.startDate));
    }
    if (dto.endDate) {
      query = query.where('audit.createdAt', '<=', new Date(dto.endDate));
    }

    const result = await executeWithCursorPagination(query, {
      perPage: dto.limit,
      cursor: dto.cursor,
      beforeCursor: dto.beforeCursor,
      fields: [
        { expression: 'createdAt', direction: 'desc' },
        { expression: 'id', direction: 'desc' },
      ],
      parseCursor: (cursor) => ({
        createdAt: new Date(cursor.createdAt),
        id: cursor.id,
      }),
    });

    return {
      ...result,
      items: result.items.map((item: any) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        actorId: item.actorId,
        actorType: item.actorType,
        event: item.event,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        spaceId: item.spaceId,
        changes: item.changes,
        metadata: item.metadata,
        ipAddress: item.ipAddress,
        createdAt: item.createdAt,
        actor: item.actorUserId
          ? {
              id: item.actorUserId,
              name: item.actorName,
              email: item.actorEmail,
              avatarUrl: item.actorAvatarUrl,
            }
          : undefined,
        resource: this.toResource(item),
      })),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention')
  async getAuditRetention(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.ensureCanManageAudit(user, workspace);
    const row = await this.db
      .selectFrom('workspaces')
      .select('auditRetentionDays')
      .where('id', '=', workspace.id)
      .executeTakeFirst();
    return { retentionDays: Number(row?.auditRetentionDays ?? 365) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('retention/update')
  async updateAuditRetention(
    @Body() dto: { auditRetentionDays: number },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.ensureCanManageAudit(user, workspace);
    const retentionDays = Math.max(1, Number(dto.auditRetentionDays ?? 365));
    await this.auditService.updateRetention(workspace.id, retentionDays);
    return { retentionDays };
  }

  private ensureCanManageAudit(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit)) {
      throw new ForbiddenException();
    }
  }

  private toResource(item: any) {
    if (item.pageTitle || item.pageSlugId) {
      return {
        id: item.resourceId,
        name: item.pageTitle,
        slugId: item.pageSlugId,
      };
    }
    if (item.spaceName || item.spaceSlug) {
      return {
        id: item.spaceId ?? item.resourceId,
        name: item.spaceName,
        slug: item.spaceSlug,
      };
    }
    return item.resourceId
      ? {
          id: item.resourceId,
          name: item.metadata?.title ?? item.resourceType,
        }
      : undefined;
  }
}
