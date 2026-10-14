import { Module } from '@nestjs/common';
import { PresenceController } from './presence.controller';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { CaslModule } from '../../core/casl/casl.module';

@Module({
  imports: [CollaborationModule, CaslModule],
  controllers: [PresenceController],
})
export class PresenceModule {}
