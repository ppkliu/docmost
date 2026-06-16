import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageReviewService } from './services/page-review.service';
import { ReviewPageDto, ReviewQueueDto } from './dto/page-review.dto';

/** H2 phase 1: reviewer queue + approve/reject for agent-submitted pages. */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageReviewController {
  constructor(
    private readonly pageReviewService: PageReviewService,
    private readonly pageRepo: PageRepo,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('review-queue')
  async reviewQueue(
    @Body() dto: ReviewQueueDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pageReviewService.listQueue(dto.spaceId, user, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('review')
  async review(
    @Body() dto: ReviewPageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.workspaceId !== workspace.id || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }
    return this.pageReviewService.review(page, user, dto.action, dto.note);
  }
}
