import { Global, Module } from '@nestjs/common';
import { PageAccessService } from './page-access.service';
import { PagePermissionService } from './page-permission.service';
import { PagePermissionController } from './page-permission.controller';

@Global()
@Module({
  controllers: [PagePermissionController],
  providers: [PageAccessService, PagePermissionService],
  exports: [PageAccessService, PagePermissionService],
})
export class PageAccessModule {}
