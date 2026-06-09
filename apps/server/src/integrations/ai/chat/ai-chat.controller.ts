import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import * as bytes from 'bytes';
import { validate as isValidUUID } from 'uuid';
import { AiChatService } from './ai-chat.service';
import {
  ChatIdDto,
  SearchChatsDto,
  SendChatDto,
  UpdateChatDto,
} from './dto/ai-chat.dto';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { SkipTransform } from '../../../common/decorators/skip-transform.decorator';
import { FileInterceptor } from '../../../common/interceptors/file.interceptor';
import { AttachmentService } from '../../../core/attachment/services/attachment.service';
import { EnvironmentService } from '../../environment/environment.service';
import { User, Workspace } from '@docmost/db/types/entity.types';

@UseGuards(JwtAuthGuard)
@Controller('ai/chats')
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(
    private readonly aiChatService: AiChatService,
    private readonly attachmentService: AttachmentService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    return this.aiChatService.createChat(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    return this.aiChatService.listChats(user, workspace, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    return this.aiChatService.getChatInfo(dto.chatId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    await this.aiChatService.updateTitle(
      dto.chatId,
      dto.title,
      user,
      workspace,
    );
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    await this.aiChatService.deleteChat(dto.chatId, user, workspace);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('search')
  async search(
    @Body() dto: SearchChatsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);
    return this.aiChatService.searchChats(dto.query, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('upload')
  @UseInterceptors(FileInterceptor)
  async upload(
    @Req() req: any,
    @Res() res: FastifyReply,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.aiChatService.assertEnabled(workspace);

    const maxFileSize = bytes(this.environmentService.getFileUploadSizeLimit());
    let file = null;
    try {
      file = await req.file({
        limits: { fileSize: maxFileSize, fields: 3, files: 1 },
      });
    } catch (err: any) {
      this.logger.error(err?.message);
      if (err?.statusCode === 413) {
        throw new BadRequestException(
          `File too large. Exceeds the ${this.environmentService.getFileUploadSizeLimit()} limit`,
        );
      }
    }

    if (!file) {
      throw new BadRequestException('Failed to upload file');
    }

    // chatId is optional: a new chat has no id until the first message, so the
    // file is stored unlinked and claimed by `send` via attachmentIds.
    const chatId = file.fields?.chatId?.value as string | undefined;
    if (chatId) {
      if (!isValidUUID(chatId)) {
        throw new BadRequestException('Invalid chatId');
      }
      await this.aiChatService.getOwnedChat(chatId, user, workspace);
    }

    const attachment = await this.attachmentService.uploadChatFile({
      filePromise: file,
      userId: user.id,
      workspaceId: workspace.id,
      aiChatId: chatId,
    });

    return res.send({
      id: attachment.id,
      fileName: attachment.fileName,
      fileExt: attachment.fileExt,
      fileSize: Number(attachment.fileSize),
      mimeType: attachment.mimeType,
    });
  }

  @SkipTransform()
  @Post('send')
  async send(
    @Body() dto: SendChatDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() reply: FastifyReply,
  ) {
    // Validate gate/config before hijacking so failures return a normal JSON
    // error the client surfaces via its non-OK handler.
    this.aiChatService.assertEnabled(workspace);

    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    try {
      for await (const event of this.aiChatService.streamSend(
        dto,
        user,
        workspace,
      )) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      reply.raw.write('data: [DONE]\n\n');
    } catch (err) {
      const message = (err as Error)?.message ?? 'AI chat error';
      this.logger.error(`AI chat send failed: ${message}`);
      reply.raw.write(
        `data: ${JSON.stringify({ type: 'error', message })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  }
}
