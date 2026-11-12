import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { ApiAccessLogService } from './api-access-log.service';
import { TokenModule } from '../auth/token.module';

@Module({
  imports: [TokenModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, ApiAccessLogService],
  exports: [ApiKeyService, ApiAccessLogService],
})
export class ApiKeyModule {}
