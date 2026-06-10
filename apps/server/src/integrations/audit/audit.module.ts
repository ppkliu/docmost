import { Global, Module } from '@nestjs/common';
import { AUDIT_SERVICE, AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { CaslModule } from '../../core/casl/casl.module';

@Global()
@Module({
  imports: [CaslModule],
  controllers: [AuditController],
  providers: [
    {
      provide: AUDIT_SERVICE,
      useClass: AuditService,
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
