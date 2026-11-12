import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { UserRole } from '../../../common/helpers/types/permission';
import { User, Workspace } from '@docmost/db/types/entity.types';
import {
  IWorkspaceAbility,
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../interfaces/workspace-ability.type';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

@Injectable()
export default class WorkspaceAbilityFactory {
  constructor(private readonly environmentService: EnvironmentService) {}

  createForUser(user: User, workspace: Workspace) {
    const userRole = user.role;

    switch (userRole) {
      case UserRole.OWNER:
        return buildWorkspaceOwnerAbility();
      case UserRole.ADMIN:
        return buildWorkspaceAdminAbility();
      case UserRole.MEMBER:
        return buildWorkspaceMemberAbility(
          this.environmentService.getSpaceMemberCreateEnabled(),
          !isApiRestrictedToAdmins(workspace),
        );
      default:
        throw new NotFoundException('Workspace permissions not found');
    }
  }
}

/**
 * Workspace setting "only admins can create API keys" (settings.api.restrictToAdmins).
 * Enforced here, server-side: hiding the button in the client is not a control,
 * since a member can call POST /api/api-keys/create directly.
 *
 * Restricted unless an admin explicitly turned it off (false): a key carries its
 * creator's full permissions with no scope, so members do not get one by default.
 * The client mirrors this rule in user-api-keys.tsx and restrict-api-to-admins.tsx.
 */
export function isApiRestrictedToAdmins(workspace?: Workspace | null): boolean {
  const settings = (workspace?.settings ?? {}) as { api?: { restrictToAdmins?: boolean } };
  return settings.api?.restrictToAdmins !== false;
}

function buildWorkspaceOwnerAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Audit);

  return build();
}

function buildWorkspaceAdminAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );

  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Space);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.API);

  return build();
}

function buildWorkspaceMemberAbility(
  canCreateSpace = false,
  canCreateApiKey = true,
) {
  const { can, build } = new AbilityBuilder<MongoAbility<IWorkspaceAbility>>(
    createMongoAbility,
  );
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Settings);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Member);
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Space);
  // `Create` only — deliberately not `Manage`. `Manage` on Space would also
  // grant editing and deleting *every* space in the workspace, which is what
  // the admin roles above have. A member may bring a space into existence and
  // is made its space-level ADMIN by SpaceService.createSpace; every other
  // space stays read-only to them.
  if (canCreateSpace) {
    can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.Space);
  }
  can(WorkspaceCaslAction.Read, WorkspaceCaslSubject.Group);
  can(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Attachment);
  if (canCreateApiKey) {
    can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);
  }

  return build();
}
