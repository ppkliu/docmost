import { Module } from '@nestjs/common';
import { AttachmentModule } from '../../core/attachment/attachment.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiProviderService } from './ai-provider.service';
import { AiConnectionService } from './ai-connection.service';
import { AiKbService } from './ai-kb.service';
import { KbSyncService } from './kb-sync.service';
import { AiIndexingService } from './ai-indexing.service';
import { AiAnswerService } from './ai-answer.service';
import { AiQueueProcessor } from './processors/ai-queue.processor';
import { AiChatController } from './chat/ai-chat.controller';
import { AiChatService } from './chat/ai-chat.service';

@Module({
  imports: [AttachmentModule],
  controllers: [AiController, AiChatController],
  providers: [
    AiService,
    AiProviderService,
    AiConnectionService,
    AiKbService,
    KbSyncService,
    AiIndexingService,
    AiAnswerService,
    AiQueueProcessor,
    AiChatService,
  ],
  exports: [AiService, AiProviderService, AiIndexingService],
})
export class AiModule {}
