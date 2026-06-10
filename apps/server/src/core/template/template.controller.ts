import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TemplateService } from './template.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  list(
    @Body() dto: PaginationOptions & { spaceId?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.list(user, workspace, dto, dto.spaceId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  info(@Body() dto: { templateId: string }, @AuthWorkspace() workspace: Workspace) {
    return this.templateService.info(dto.templateId, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  create(
    @Body() dto: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.create(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  update(
    @Body() dto: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const { templateId, ...payload } = dto;
    return this.templateService.update(templateId, payload, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  delete(
    @Body() dto: { templateId: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.delete(dto.templateId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('use')
  use(
    @Body()
    dto: { templateId: string; spaceId: string; parentPageId?: string },
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.templateService.use(
      dto.templateId,
      dto.spaceId,
      dto.parentPageId,
      user,
      workspace,
    );
  }
}
