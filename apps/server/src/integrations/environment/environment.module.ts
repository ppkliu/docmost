import { Global, Module } from '@nestjs/common';
import { EnvironmentService } from './environment.service';
import { ConfigModule } from '@nestjs/config';
import { validate } from './environment.validation';
import { envPath } from '../../common/helpers';
import { DomainService } from './domain.service';
import { LicenseCheckService } from './license-check.service';
import { NetworkOriginService } from '../../common/services/network-origin.service';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      expandVariables: true,
      envFilePath: envPath,
      validate,
    }),
  ],
  providers: [
    EnvironmentService,
    DomainService,
    LicenseCheckService,
    NetworkOriginService,
  ],
  exports: [
    EnvironmentService,
    DomainService,
    LicenseCheckService,
    NetworkOriginService,
  ],
})
export class EnvironmentModule {}
