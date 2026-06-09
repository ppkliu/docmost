jest.mock('ai', () => ({
  streamText: jest.fn(),
  // pass-through helpers so the service can build tool sets in tests
  tool: (def: unknown) => def,
  stepCountIs: (n: number) => n,
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { streamText } from 'ai';
import { AiChatService, AiChatStreamEvent } from './ai-chat.service';

const user = { id: 'u1' } as any;
const workspace = { id: 'w1', settings: { ai: { chat: true } } } as any;

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    insertChat: jest.fn(),
    findChatById: jest.fn(),
    findChats: jest.fn(),
    updateChat: jest.fn().mockResolvedValue(undefined),
    softDeleteChat: jest.fn().mockResolvedValue(undefined),
    searchChats: jest.fn(),
    insertMessage: jest.fn(),
    findMessages: jest.fn(),
    ...overrides,
  };
}

function makeProvider(configured = true) {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    completionModel: jest.fn().mockReturnValue({}),
  };
}

function makeAnswer(overrides: Partial<Record<string, any>> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(false),
    retrieve: jest.fn(),
    loadPagesContext: jest
      .fn()
      .mockResolvedValue({ context: '', sources: [] }),
    ...overrides,
  };
}

function makeAttachmentRepo() {
  return { linkAttachmentsToAiChat: jest.fn().mockResolvedValue(undefined) };
}

function makeService(
  repo = makeRepo(),
  provider = makeProvider(),
  answer = makeAnswer(),
  attachmentRepo = makeAttachmentRepo(),
) {
  return new AiChatService(
    repo as any,
    provider as any,
    answer as any,
    attachmentRepo as any,
  );
}

/** Builds a streamText mock whose fullStream replays the given parts. */
function mockFullStream(parts: any[]) {
  (streamText as jest.Mock).mockReturnValue({
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  });
}

async function drain(
  gen: AsyncGenerator<AiChatStreamEvent>,
): Promise<AiChatStreamEvent[]> {
  const events: AiChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('AiChatService', () => {
  afterEach(() => jest.clearAllMocks());

  describe('CRUD', () => {
    it('createChat inserts a chat scoped to the user/workspace', async () => {
      const repo = makeRepo({
        insertChat: jest.fn().mockResolvedValue({ id: 'c1', title: null }),
      });
      const svc = makeService(repo);

      const chat = await svc.createChat(user, workspace);

      expect(repo.insertChat).toHaveBeenCalledWith({
        workspaceId: 'w1',
        creatorId: 'u1',
        title: null,
      });
      expect(chat).toEqual({ id: 'c1', title: null });
    });

    it('getChatInfo throws NotFound when the chat does not exist', async () => {
      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue(undefined),
      });
      const svc = makeService(repo);

      await expect(svc.getChatInfo('missing', user, workspace)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updateTitle updates an owned chat', async () => {
      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue({ id: 'c1' }),
      });
      const svc = makeService(repo);

      await svc.updateTitle('c1', 'My title', user, workspace);

      expect(repo.updateChat).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'My title' }),
        'c1',
      );
    });
  });

  describe('assertEnabled', () => {
    it('throws Forbidden when the workspace AI chat toggle is off', () => {
      const svc = makeService();
      expect(() =>
        svc.assertEnabled({ id: 'w1', settings: { ai: { chat: false } } } as any),
      ).toThrow(ForbiddenException);
    });
  });

  describe('streamSend', () => {
    it('yields a single error event when AI is not configured', async () => {
      const svc = makeService(makeRepo(), makeProvider(false));

      const events = await drain(
        svc.streamSend({ content: 'hi' } as any, user, workspace),
      );

      expect(events).toEqual([
        expect.objectContaining({ type: 'error', code: 'not_configured' }),
      ]);
    });

    it('creates a chat, streams content, and persists user + assistant messages', async () => {
      mockFullStream([
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', text: ' world' },
        {
          type: 'finish',
          totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ]);

      const repo = makeRepo({
        insertChat: jest.fn().mockResolvedValue({ id: 'c1', title: null }),
        insertMessage: jest
          .fn()
          .mockResolvedValueOnce({ id: 'm-user' })
          .mockResolvedValueOnce({ id: 'm-assistant' }),
        findMessages: jest
          .fn()
          .mockResolvedValue([{ role: 'user', content: 'How are you?' }]),
      });
      const svc = makeService(repo);

      const events = await drain(
        svc.streamSend({ content: 'How are you?' } as any, user, workspace),
      );

      expect(events[0]).toEqual({ type: 'chat_created', chatId: 'c1' });
      expect(events).toContainEqual({ type: 'content', text: 'Hello' });
      expect(events).toContainEqual({ type: 'content', text: ' world' });
      expect(events[events.length - 1]).toEqual({
        type: 'done',
        messageId: 'm-assistant',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      });

      expect(repo.insertMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ role: 'user', content: 'How are you?' }),
      );
      expect(repo.insertMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          role: 'assistant',
          content: 'Hello world',
          toolCalls: null,
        }),
      );
      expect(repo.updateChat).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'How are you?' }),
        'c1',
      );
    });

    it('emits tool_call/tool_result events and persists tool calls', async () => {
      mockFullStream([
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'search_workspace',
          input: { query: 'roadmap' },
        },
        {
          type: 'tool-result',
          toolCallId: 't1',
          output: { results: [{ pageId: 'p1', title: 'Roadmap' }] },
        },
        { type: 'text-delta', text: 'Per the roadmap...' },
        {
          type: 'finish',
          totalUsage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
        },
      ]);

      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue({ id: 'c1', title: 't' }),
        insertMessage: jest
          .fn()
          .mockResolvedValueOnce({ id: 'm-user' })
          .mockResolvedValueOnce({ id: 'm-assistant' }),
        findMessages: jest.fn().mockResolvedValue([]),
      });
      // embeddings configured -> the search tool is offered
      const svc = makeService(
        repo,
        makeProvider(),
        makeAnswer({ isConfigured: jest.fn().mockReturnValue(true) }),
      );

      const events = await drain(
        svc.streamSend(
          { chatId: 'c1', content: 'what is the roadmap?' } as any,
          user,
          workspace,
        ),
      );

      expect(events).toContainEqual({
        type: 'tool_call',
        id: 't1',
        name: 'search_workspace',
        args: { query: 'roadmap' },
      });
      expect(events).toContainEqual({
        type: 'tool_result',
        id: 't1',
        result: { results: [{ pageId: 'p1', title: 'Roadmap' }] },
      });
      // the assistant message stores the tool call with its result
      expect(repo.insertMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [
            expect.objectContaining({
              id: 't1',
              name: 'search_workspace',
              args: { query: 'roadmap' },
              result: { results: [{ pageId: 'p1', title: 'Roadmap' }] },
            }),
          ],
        }),
      );
    });

    it('surfaces a retryable error event when the model call fails', async () => {
      (streamText as jest.Mock).mockImplementation(() => {
        throw new Error('upstream 500');
      });
      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue({ id: 'c1', title: 'x' }),
        insertMessage: jest.fn().mockResolvedValue({ id: 'm-user' }),
        findMessages: jest.fn().mockResolvedValue([]),
      });
      const svc = makeService(repo);

      const events = await drain(
        svc.streamSend(
          { chatId: 'c1', content: 'hi' } as any,
          user,
          workspace,
        ),
      );

      expect(events[events.length - 1]).toEqual(
        expect.objectContaining({
          type: 'error',
          message: 'upstream 500',
          retryable: true,
        }),
      );
    });
  });
});
