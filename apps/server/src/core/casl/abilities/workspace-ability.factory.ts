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
        );
      default:
        throw new NotFoundException('Workspace permissions not found');
    }
  }
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

function buildWorkspaceMemberAbility(canCreateSpace = false) {
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
  can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);

  return build();
}
