import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { AiProviderService, ResolvedAiConfig } from '../ai-provider.service';
import { AiAnswerService } from '../ai-answer.service';
import { AiKbService } from '../ai-kb.service';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import {
  AiChat,
  AiChatMessage,
  User,
  Workspace,
} from '@docmost/db/types/entity.types';
import { SendChatDto } from './dto/ai-chat.dto';

/** Server → client SSE events; mirrors the client `AiChatStreamEvent` union. */
export type AiChatStreamEvent =
  | { type: 'chat_created'; chatId: string }
  | { type: 'content'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'done'; messageId: string; usage?: Record<string, number> }
  | { type: 'error'; message: string; code?: string; retryable?: boolean };

const CHAT_SYSTEM_PROMPT =
  'You are a helpful AI assistant embedded in the Docmost wiki. ' +
  'Answer the user clearly and concisely using Markdown. ' +
  'If you are unsure or lack the information, say so rather than inventing facts.';

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiProviderService: AiProviderService,
    private readonly aiAnswerService: AiAnswerService,
    private readonly aiKbService: AiKbService,
    private readonly attachmentRepo: AttachmentRepo,
  ) {}

  /** Public ownership check used by the upload endpoint. */
  async getOwnedChat(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<AiChat> {
    return this.requireChat(chatId, user, workspace);
  }

  isConfigured(): boolean {
    return this.aiProviderService.isConfigured();
  }

  async createChat(user: User, workspace: Workspace): Promise<AiChat> {
    return this.aiChatRepo.insertChat({
      workspaceId: workspace.id,
      creatorId: user.id,
      title: null,
    });
  }

  async listChats(
    user: User,
    workspace: Workspace,
    pagination: PaginationOptions,
  ) {
    return this.aiChatRepo.findChats(workspace.id, user.id, pagination);
  }

  async getChatInfo(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<{ chat: AiChat; messages: AiChatMessage[] }> {
    const chat = await this.requireChat(chatId, user, workspace);
    const messages = await this.aiChatRepo.findMessages(chat.id);
    return { chat, messages };
  }

  async deleteChat(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const chat = await this.requireChat(chatId, user, workspace);
    await this.aiChatRepo.softDeleteChat(chat.id);
  }

  async updateTitle(
    chatId: string,
    title: string,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const chat = await this.requireChat(chatId, user, workspace);
    await this.aiChatRepo.updateChat({ title, updatedAt: new Date() }, chat.id);
  }

  async searchChats(
    query: string,
    user: User,
    workspace: Workspace,
  ): Promise<AiChat[]> {
    return this.aiChatRepo.searchChats(workspace.id, user.id, query);
  }

  /**
   * Streams an assistant reply as SSE events, persisting both the user message
   * and the assistant message. Creates the chat on the fly when no chatId is
   * given (emitting `chat_created`). Runs a bounded tool-calling loop: the
   * model may call the wiki `search_workspace` tool (when embeddings are
   * configured), and explicitly referenced pages (`contextPageId` /
   * `mentionedPageIds`) are injected as grounding context. Attachment context
   * (`attachmentIds`) is layered on in B3.4; it is accepted but not yet used.
   */
  async *streamSend(
    dto: SendChatDto,
    user: User,
    workspace: Workspace,
  ): AsyncGenerator<AiChatStreamEvent> {
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    if (!this.aiProviderService.isConfigured(cfg)) {
      yield {
        type: 'error',
        message: 'AI is not configured on this server',
        code: 'not_configured',
        retryable: false,
      };
      return;
    }

    // Resolve the chat (load existing or create a new one).
    let chat: AiChat;
    if (dto.chatId) {
      chat = await this.requireChat(dto.chatId, user, workspace);
    } else {
      chat = await this.createChat(user, workspace);
      yield { type: 'chat_created', chatId: chat.id };
    }

    // Persist the incoming user message before contacting the model so the
    // turn is durable even if streaming fails midway.
    await this.aiChatRepo.insertMessage({
      chatId: chat.id,
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      content: dto.content,
    });

    // Claim any files the client uploaded for this turn (links unlinked rows
    // uploaded before the chat existed) so they belong to the chat.
    if (dto.attachmentIds?.length) {
      await this.attachmentRepo.linkAttachmentsToAiChat(
        dto.attachmentIds,
        chat.id,
        user.id,
        workspace.id,
      );
    }

    // First user message becomes the chat title (until renamed).
    if (!chat.title) {
      await this.aiChatRepo.updateChat(
        { title: this.deriveTitle(dto.content), updatedAt: new Date() },
        chat.id,
      );
    }

    const history = await this.aiChatRepo.findMessages(chat.id);
    const system = await this.buildSystemPrompt(dto, user);
    const messages = this.toModelMessages(history);
    const tools = this.buildTools(user, workspace, cfg);

    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
    }> = [];
    let assistantText = '';
    let usage: Record<string, number> | undefined;

    try {
      const result = streamText({
        model: this.aiProviderService.completionModel(cfg),
        system,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        // Bound the agentic loop so a misbehaving model cannot spin forever.
        stopWhen: stepCountIs(6),
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            assistantText += part.text;
            yield { type: 'content', text: part.text };
            break;
          case 'tool-call': {
            const args = (part.input ?? {}) as Record<string, unknown>;
            toolCalls.push({ id: part.toolCallId, name: part.toolName, args });
            yield {
              type: 'tool_call',
              id: part.toolCallId,
              name: part.toolName,
              args,
            };
            break;
          }
          case 'tool-result': {
            const entry = toolCalls.find((t) => t.id === part.toolCallId);
            if (entry) entry.result = part.output;
            yield {
              type: 'tool_result',
              id: part.toolCallId,
              result: part.output,
            };
            break;
          }
          case 'tool-error': {
            const result = { error: this.errorMessage(part.error) };
            const entry = toolCalls.find((t) => t.id === part.toolCallId);
            if (entry) entry.result = result;
            yield { type: 'tool_result', id: part.toolCallId, result };
            break;
          }
          case 'finish': {
            const u = part.totalUsage;
            usage = {
              promptTokens: u?.inputTokens ?? 0,
              completionTokens: u?.outputTokens ?? 0,
              totalTokens: u?.totalTokens ?? 0,
            };
            break;
          }
          case 'error':
            throw new Error(this.errorMessage(part.error));
        }
      }
    } catch (err) {
      const message = (err as Error)?.message ?? 'AI request failed';
      this.logger.error(`AI chat stream failed (chat=${chat.id}): ${message}`);
      yield { type: 'error', message, retryable: true };
      return;
    }

    const assistantMessage = await this.aiChatRepo.insertMessage({
      chatId: chat.id,
      workspaceId: workspace.id,
      userId: null,
      role: 'assistant',
      content: assistantText,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      metadata: usage ? { usage } : null,
    });
    await this.aiChatRepo.updateChat({ updatedAt: new Date() }, chat.id);

    yield { type: 'done', messageId: assistantMessage.id, usage };
  }

  /**
   * Wiki tools the model can call during a turn. `search_workspace` is only
   * offered when embeddings are configured; its results are scoped to the
   * caller's accessible spaces by AiAnswerService.
   */
  private buildTools(
    user: User,
    workspace: Workspace,
    cfg: ResolvedAiConfig,
  ): ToolSet {
    const tools: ToolSet = {};

    if (this.aiAnswerService.isConfigured(cfg)) {
      tools.search_workspace = tool({
        description:
          'Semantic search over the wiki the user can access. Use it to ground answers in their pages before replying.',
        inputSchema: z.object({
          query: z.string().describe('Natural-language search query'),
        }),
        execute: async ({ query }) => {
          const { sources } = await this.aiAnswerService.retrieve(
            query,
            {
              userId: user.id,
              workspaceId: workspace.id,
            },
            cfg,
          );
          return {
            results: sources.map((s) => ({
              pageId: s.pageId,
              title: s.title,
              excerpt: s.excerpt,
              similarity: Number(s.similarity.toFixed(3)),
            })),
          };
        },
      });
    }

    // K2: federated search over external knowledge bases (Cognee / LLM-Wiki /
    // custom). One tool per enabled connector; failures are returned as data
    // so one unreachable KB doesn't abort the chat turn.
    const connectors = this.aiKbService
      .getConnectors(workspace.settings as any)
      .filter((kb) => kb.enabled);
    for (const connector of connectors) {
      const toolName = `search_${connector.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)}`;
      if (tools[toolName]) continue; // duplicate sanitized names: first wins

      tools[toolName] = tool({
        description:
          `Search the external knowledge base "${connector.name}" (${connector.type}). ` +
          'Use it when the wiki itself may not contain the answer.',
        inputSchema: z.object({
          query: z.string().describe('Natural-language search query'),
        }),
        execute: async ({ query }) => {
          try {
            const results = await this.aiKbService.search(connector, query, {
              limit: 5,
            });
            return { source: connector.name, results };
          } catch (err) {
            this.logger.warn(
              `KB search failed (${connector.name}): ${(err as Error)?.message}`,
            );
            return {
              source: connector.name,
              error: 'knowledge base unreachable',
              results: [],
            };
          }
        },
      });
    }

    return tools;
  }

  /** Main system prompt plus grounding context from @mentions / current page. */
  private async buildSystemPrompt(
    dto: SendChatDto,
    user: User,
  ): Promise<string> {
    const pageIds = [
      ...(dto.mentionedPageIds ?? []),
      ...(dto.contextPageId ? [dto.contextPageId] : []),
    ];
    if (pageIds.length === 0) return CHAT_SYSTEM_PROMPT;

    const { context } = await this.aiAnswerService.loadPagesContext(
      pageIds,
      user.id,
    );
    if (!context) return CHAT_SYSTEM_PROMPT;

    return `${CHAT_SYSTEM_PROMPT}\n\nThe user referenced these wiki pages as context:\n\n${context}`;
  }

  private errorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    return (error as Error)?.message ?? 'AI stream error';
  }

  private async requireChat(
    chatId: string,
    user: User,
    workspace: Workspace,
  ): Promise<AiChat> {
    const chat = await this.aiChatRepo.findChatById(
      chatId,
      workspace.id,
      user.id,
    );
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }
    return chat;
  }

  /** Maps stored messages to the AI SDK message format (user/assistant only). */
  private toModelMessages(messages: AiChatMessage[]): ModelMessage[] {
    return messages
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      )
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
      }));
  }

  private deriveTitle(content: string): string {
    const firstLine = content.trim().split('\n')[0].trim();
    if (firstLine.length <= 60) return firstLine || 'New chat';
    return `${firstLine.slice(0, 57)}...`;
  }

  assertEnabled(workspace: Workspace): void {
    const settings = workspace.settings as {
      ai?: { chat?: boolean };
    } | null;
    if (settings?.ai?.chat !== true) {
      throw new ForbiddenException('AI Chat is not enabled for this workspace');
    }
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    if (!this.aiProviderService.isConfigured(cfg)) {
      throw new BadRequestException('AI is not configured on this server');
    }
  }
}
