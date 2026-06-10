import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PageService } from '../page/services/page.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { jsonToText } from '../../collaboration/collaboration.util';
import { createYdocFromJson } from '../../common/helpers/prosemirror/utils';

type TemplatePayload = {
  title?: string;
  description?: string;
  icon?: string;
  spaceId?: string | null;
  content?: any;
};

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepo,
    private readonly pageService: PageService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async list(
    user: User,
    workspace: Workspace,
    pagination: PaginationOptions,
    spaceId?: string,
  ) {
    const accessibleSpaceIds = await this.getReadableSpaceIds(user, workspace.id);
    return this.templateRepo.findTemplates(workspace.id, accessibleSpaceIds, pagination, {
      spaceId,
    });
  }

  async info(templateId: string, workspace: Workspace) {
    const template = await this.templateRepo.findById(templateId, workspace.id, {
      includeContent: true,
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  async create(payload: TemplatePayload, user: User, workspace: Workspace) {
    await this.ensureCanManageTemplateScope(payload.spaceId ?? null, user, workspace);
    const content = payload.content ?? this.emptyDoc();
    const { id } = await this.templateRepo.insertTemplate({
      title: payload.title ?? 'Untitled',
      description: payload.description ?? null,
      icon: payload.icon ?? null,
      spaceId: payload.spaceId ?? null,
      workspaceId: workspace.id,
      creatorId: user.id,
      lastUpdatedById: user.id,
      content,
      textContent: jsonToText(content),
      ydoc: createYdocFromJson(content),
    });
    return this.info(id, workspace);
  }

  async update(
    templateId: string,
    payload: TemplatePayload,
    user: User,
    workspace: Workspace,
  ) {
    const template = await this.info(templateId, workspace);
    await this.ensureCanManageTemplateScope(template.spaceId ?? null, user, workspace);
    if (payload.spaceId !== undefined && payload.spaceId !== template.spaceId) {
      await this.ensureCanManageTemplateScope(payload.spaceId ?? null, user, workspace);
    }

    const update: any = {
      lastUpdatedById: user.id,
    };
    if (payload.title !== undefined) update.title = payload.title;
    if (payload.description !== undefined) update.description = payload.description;
    if (payload.icon !== undefined) update.icon = payload.icon;
    if (payload.spaceId !== undefined) update.spaceId = payload.spaceId ?? null;
    if (payload.content !== undefined) {
      update.content = payload.content;
      update.textContent = jsonToText(payload.content);
      update.ydoc = createYdocFromJson(payload.content);
    }

    await this.templateRepo.updateTemplate(update, templateId, workspace.id);
    return this.info(templateId, workspace);
  }

  async delete(templateId: string, user: User, workspace: Workspace) {
    const template = await this.info(templateId, workspace);
    await this.ensureCanManageTemplateScope(template.spaceId ?? null, user, workspace);
    await this.templateRepo.deleteTemplate(templateId, workspace.id);
  }

  async use(
    templateId: string,
    spaceId: string,
    parentPageId: string | undefined,
    user: User,
    workspace: Workspace,
  ) {
    const template = await this.info(templateId, workspace);
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    return this.pageService.create(user.id, workspace.id, {
      title: template.title ?? 'Untitled',
      icon: template.icon ?? undefined,
      spaceId,
      parentPageId,
      content: (template.content && typeof template.content === 'object'
        ? template.content
        : this.emptyDoc()) as object,
      format: 'json',
    });
  }

  private async ensureCanManageTemplateScope(
    spaceId: string | null,
    user: User,
    workspace: Workspace,
  ) {
    if (!spaceId) {
      const ability = this.workspaceAbility.createForUser(user, workspace);
      if (
        ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
      ) {
        throw new ForbiddenException();
      }
      return;
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async getReadableSpaceIds(user: User, workspaceId: string) {
    const spaces = await this.db
      .selectFrom('spaces')
      .select(['id'])
      .where('workspaceId', '=', workspaceId)
      .execute();
    const readable: string[] = [];
    for (const space of spaces) {
      try {
        const ability = await this.spaceAbility.createForUser(user, space.id);
        if (ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
          readable.push(space.id);
        }
      } catch {
        // user has no role in this space
      }
    }
    return readable;
  }

  private emptyDoc() {
    return { type: 'doc', content: [] };
  }
}
