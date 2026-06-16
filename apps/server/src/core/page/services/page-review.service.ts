import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import SpaceAbilityFactory from '../../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../casl/interfaces/space-ability.type';
import { PagePermissionService } from '../page-access/page-permission.service';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';

const QUEUE_LIMIT = 100;

/**
 * H2 phase 1: review workflow for agent-submitted pages
 * (created with requestReview -> reviewStatus 'pending'). Pending/rejected
 * pages are excluded from AI indexing and KB sync (H2.2); approval re-admits
 * them, rejection trashes them with an optional note comment.
 */
@Injectable()
export class PageReviewService {
  private readonly logger = new Logger(PageReviewService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
    private readonly commentRepo: CommentRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pagePermissionService: PagePermissionService,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
  ) {}

  /** Pending pages of one space, newest first (v1: capped, no pagination). */
  async listQueue(spaceId: string, user: User, workspaceId: string) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const items = await this.db
      .selectFrom('pages')
      .leftJoin('users', 'users.id', 'pages.creatorId')
      .select([
        'pages.id',
        'pages.slugId',
        'pages.title',
        'pages.icon',
        'pages.createdAt',
        'pages.creatorId',
        'users.name as creatorName',
      ])
      .where('pages.spaceId', '=', spaceId)
      .where('pages.workspaceId', '=', workspaceId)
      .where('pages.reviewStatus', '=', 'pending')
      .where('pages.deletedAt', 'is', null)
      .orderBy('pages.createdAt', 'desc')
      .limit(QUEUE_LIMIT)
      .execute();

    return { items };
  }

  async review(
    page: Page,
    user: User,
    action: 'approve' | 'reject',
    note?: string,
  ): Promise<{ pageId: string; reviewStatus: string }> {
    if (page.reviewStatus !== 'pending') {
      throw new BadRequestException('Page is not pending review');
    }

    const info = await this.pagePermissionService.getRestrictionInfo(
      page,
      user,
    );
    if (!info.userAccess.canManage) {
      throw new ForbiddenException(
        'You do not have permission to review this page',
      );
    }

    if (action === 'approve') {
      await this.pageRepo.updatePage(
        { reviewStatus: 'approved' } as any,
        page.id,
      );
      // approved content may now enter retrieval (embedding + KB sync fan-out)
      await this.aiQueue.add(QueueJob.GENERATE_PAGE_EMBEDDINGS, {
        pageIds: [page.id],
        workspaceId: page.workspaceId,
      });
      this.logger.log(`Page ${page.id} approved by ${user.id}`);
      return { pageId: page.id, reviewStatus: 'approved' };
    }

    // reject: leave a note (optional), then trash
    if (note?.trim()) {
      await this.commentRepo.insertComment({
        pageId: page.id,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: `Rejected: ${note.trim()}` }],
            },
          ],
        },
        type: 'page',
        creatorId: user.id,
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
      } as any);
    }
    await this.pageRepo.updatePage(
      { reviewStatus: 'rejected' } as any,
      page.id,
    );
    await this.pageRepo.removePage(page.id, user.id, page.workspaceId);
    this.logger.log(`Page ${page.id} rejected by ${user.id}`);
    return { pageId: page.id, reviewStatus: 'rejected' };
  }
}
