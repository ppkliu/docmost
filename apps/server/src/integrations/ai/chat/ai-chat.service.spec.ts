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
    resolveConfig: jest.fn().mockReturnValue({ driver: 'openai' }),
    isConfigured: jest.fn().mockReturnValue(configured),
    completionModel: jest.fn().mockReturnValue({}),
  };
}

function makeAnswer(overrides: Partial<Record<string, any>> = {}) {
  return {
    isConfigured: jest.fn().mockReturnValue(false),
    retrieve: jest.fn(),
    loadPagesContext: jest.fn().mockResolvedValue({ context: '', sources: [] }),
    ...overrides,
  };
}

function makeAttachmentRepo() {
  return { linkAttachmentsToAiChat: jest.fn().mockResolvedValue(undefined) };
}

function makeKb(overrides: Partial<Record<string, any>> = {}) {
  return {
    getConnectors: jest.fn().mockReturnValue([]),
    search: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeService(
  repo = makeRepo(),
  provider = makeProvider(),
  answer = makeAnswer(),
  attachmentRepo = makeAttachmentRepo(),
  kb = makeKb(),
) {
  return new AiChatService(
    repo as any,
    provider as any,
    answer as any,
    kb as any,
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
        svc.assertEnabled({
          id: 'w1',
          settings: { ai: { chat: false } },
        } as any),
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

    it('registers a federated search tool per enabled KB connector', async () => {
      mockFullStream([
        { type: 'text-delta', text: 'ok' },
        {
          type: 'finish',
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
      const kb = makeKb({
        getConnectors: jest.fn().mockReturnValue([
          {
            id: 'kb1',
            type: 'cognee',
            name: 'Team Cognee',
            baseUrl: 'http://kb',
            enabled: true,
          },
          {
            id: 'kb2',
            type: 'custom',
            name: 'Old KB',
            baseUrl: 'http://old',
            enabled: false,
          },
        ]),
        search: jest
          .fn()
          .mockResolvedValue([{ title: 'Doc', content: 'text' }]),
      });
      const svc = makeService(
        repo,
        makeProvider(),
        makeAnswer(),
        makeAttachmentRepo(),
        kb,
      );

      await drain(
        svc.streamSend({ chatId: 'c1', content: 'q' } as any, user, workspace),
      );

      const callArgs = (streamText as jest.Mock).mock.calls[0][0];
      const toolNames = Object.keys(callArgs.tools ?? {});
      expect(toolNames).toContain('search_team_cognee');
      // disabled connectors are not offered
      expect(toolNames).not.toContain('search_old_kb');

      // the tool returns attributed results...
      const ok = await callArgs.tools.search_team_cognee.execute({
        query: 'x',
      });
      expect(ok).toEqual({
        source: 'Team Cognee',
        results: [{ title: 'Doc', content: 'text' }],
      });
      // ...and degrades to an error payload instead of throwing
      kb.search.mockRejectedValueOnce(new Error('boom'));
      const failed = await callArgs.tools.search_team_cognee.execute({
        query: 'x',
      });
      expect(failed).toEqual({
        source: 'Team Cognee',
        error: 'knowledge base unreachable',
        results: [],
      });
    });

    it('merges referenced page context into the leading system prompt', async () => {
      mockFullStream([
        { type: 'text-delta', text: 'Using the page context.' },
        {
          type: 'finish',
          totalUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        },
      ]);

      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue({ id: 'c1', title: 't' }),
        insertMessage: jest
          .fn()
          .mockResolvedValueOnce({ id: 'm-user' })
          .mockResolvedValueOnce({ id: 'm-assistant' }),
        findMessages: jest
          .fn()
          .mockResolvedValue([{ role: 'user', content: 'Explain this page' }]),
      });
      const answer = makeAnswer({
        loadPagesContext: jest.fn().mockResolvedValue({
          context: 'Page: Roadmap\nThe roadmap says ship AI chat.',
          sources: [],
        }),
      });
      const svc = makeService(repo, makeProvider(), answer);

      await drain(
        svc.streamSend(
          {
            chatId: 'c1',
            content: 'Explain this page',
            contextPageId: 'p1',
          } as any,
          user,
          workspace,
        ),
      );

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining(
            'The user referenced these wiki pages as context',
          ),
          messages: [
            expect.objectContaining({
              role: 'user',
              content: 'Explain this page',
            }),
          ],
        }),
      );
      expect(
        (streamText as jest.Mock).mock.calls[0][0].messages,
      ).not.toContainEqual(expect.objectContaining({ role: 'system' }));
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
        svc.streamSend({ chatId: 'c1', content: 'hi' } as any, user, workspace),
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
