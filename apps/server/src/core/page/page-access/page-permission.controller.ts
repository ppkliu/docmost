import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { PageIdDto } from '../dto/page.dto';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  UpdatePagePermissionRoleDto,
} from '../dto/page-permission.dto';
import { PagePermissionService } from './page-permission.service';

/**
 * Page-level permission management, matching the client contract in
 * apps/client/src/ee/page-permission/services/page-permission-service.ts.
 * Enforcement of these records is in PageAccessService (already OSS).
 */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PagePermissionController {
  constructor(
    private readonly pagePermissionService: PagePermissionService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('restrict')
  async restrict(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    await this.pagePermissionService.restrict(page, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-restriction')
  async removeRestriction(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    await this.pagePermissionService.unrestrict(page, user);
  }

  @HttpCode(HttpStatus.OK)
  @Post('add-permission')
  async addPermission(
    @Body() dto: AddPagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    await this.pagePermissionService.addPermissions(page, user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-permission')
  async removePermission(
    @Body() dto: RemovePagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    await this.pagePermissionService.removePermissions(page, user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-permission')
  async updatePermission(
    @Body() dto: UpdatePagePermissionRoleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    await this.pagePermissionService.updateRole(page, user, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('permissions')
  async listPermissions(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    return this.pagePermissionService.listPermissions(page, user, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('permission-info')
  async permissionInfo(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pagePermissionService.getPageOrThrow(
      dto.pageId,
      workspace.id,
    );
    return this.pagePermissionService.getRestrictionInfo(page, user);
  }
}
