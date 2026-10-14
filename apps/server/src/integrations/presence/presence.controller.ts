import {
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
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
import { CollaborationGateway } from '../../collaboration/collaboration.gateway';
import { WsGateway } from '../../ws/ws.gateway';

/**
 * Live presence for operators: who has the app open and who is editing what.
 *
 * `user_sessions.last_active_at` is only written every 15 minutes
 * (session-activity.service.ts), so it cannot answer "is anyone online right
 * now". The two websocket servers can: every open tab holds a socket.io
 * connection, and every open editor holds a collaboration connection.
 *
 * Workspace admins only. Counts cover this process; with several server
 * instances each one reports its own connections.
 */
@UseGuards(JwtAuthGuard)
@Controller('presence')
export class PresenceController {
  constructor(
    private readonly collaborationGateway: CollaborationGateway,
    private readonly wsGateway: WsGateway,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('online')
  async online(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    // socket.io: one connection per open browser tab, joined to the workspace room
    const tabsByUser = new Map<string, number>();
    const sockets =
      this.wsGateway.server?.sockets.adapter.rooms.get(
        `workspace-${workspace.id}`,
      ) ?? new Set<string>();
    for (const socketId of sockets) {
      const userId = this.wsGateway.server.sockets.sockets.get(socketId)?.data
        ?.userId;
      if (!userId) continue;
      tabsByUser.set(userId, (tabsByUser.get(userId) ?? 0) + 1);
    }

    const { documents } = this.collaborationGateway.getPresence(workspace.id);

    return {
      at: new Date().toISOString(),
      users: [...tabsByUser].map(([userId, tabs]) => ({ userId, tabs })),
      tabCount: sockets.size,
      documents: documents.map((d) => ({
        pageId: d.name.replace(/^page\./, ''),
        connections: d.connections,
        userIds: d.userIds,
        unsaved: d.unsaved,
      })),
      unsavedCount: documents.filter((d) => d.unsaved).length,
    };
  }
}
