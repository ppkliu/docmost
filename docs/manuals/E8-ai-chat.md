# E8 — AI Chat (Assistant) — Usage & Testing Manual

> Status: **implemented (OSS)**. Multi-turn streamed chat with the workspace AI, an
> agentic tool-calling loop (wiki semantic search), page-context grounding (@mentions /
> current page), and chat file attachments. Rides on the already-unlocked `Feature.AI`
> entitlement — no EE license required.

## 1. What it does
- Persistent, per-user chats (`ai_chats` / `ai_chat_messages`) scoped to the workspace.
- Streamed assistant replies over Server-Sent Events.
- A bounded tool-calling loop: when embeddings are configured, the model can call
  `search_workspace` (access-controlled semantic search) to ground answers in the user's
  pages; the UI shows each `tool_call` / `tool_result`.
- Grounding context from explicitly referenced pages (`contextPageId`, `mentionedPageIds`),
  restricted to spaces the user can access.
- File attachments per chat (stored under `…/chat-files`, linked via `attachments.ai_chat_id`).

## 2. Prerequisites / configuration
1. **Configure an AI provider** (env), e.g. OpenAI-compatible:
   ```dotenv
   AI_DRIVER=openai-compatible       # openai | openai-compatible | gemini | ollama
   OPENAI_API_URL=https://api.example.com/v1
   OPENAI_API_KEY=sk-...
   AI_COMPLETION_MODEL=gpt-4o-mini
   # optional — enables the search_workspace tool + AI Search:
   AI_EMBEDDING_MODEL=text-embedding-3-small
   AI_EMBEDDING_DIMENSION=1536
   ```
2. **Enable the toggle**: *Settings → AI → AI Chat* (admin). Persists to
   `workspaces.settings.ai.chat = true`.
3. **Rebuild/restart** the app so the new env + build are live (`docker compose up -d --build`).

> Without embeddings (`AI_EMBEDDING_*`), chat still works — it just runs without the
> `search_workspace` tool (plain completion + any explicit page context).

## 3. Usage

### Frontend
Open the AI Chat panel/page, type a message, send. Replies stream token-by-token. Tool
calls render inline (the search step + its results). @mention pages or open a chat from a
page to pass page context. Attach files with the upload control. Past chats list in the
sidebar with search; titles auto-generate from the first message and are editable.

### REST API (all `POST`, JWT auth, gated by `Feature.AI` + `settings.ai.chat`)
| Endpoint | Body | Returns |
|---|---|---|
| `/api/ai/chats/create` | — | `AiChat` |
| `/api/ai/chats` | `{ limit?, cursor? }` | `{ items: AiChat[], meta }` (cursor-paginated) |
| `/api/ai/chats/info` | `{ chatId }` | `{ chat, messages }` |
| `/api/ai/chats/update` | `{ chatId, title }` | `{ success: true }` |
| `/api/ai/chats/delete` | `{ chatId }` | `{ success: true }` (soft-delete) |
| `/api/ai/chats/search` | `{ query }` | `AiChat[]` (title + message full-text) |
| `/api/ai/chats/upload` | multipart `file` (+ optional `chatId`) | `ChatAttachment` |
| `/api/ai/chats/send` | `{ chatId?, content, mentionedPageIds?, contextPageId?, attachmentIds? }` | **SSE stream** |

**SSE `send` events** (`data: <json>\n\n`, terminated by `data: [DONE]`):
`chat_created` · `content` · `tool_call` · `tool_result` · `done` (with `usage`) · `error`.
A new chat (no `chatId`) emits `chat_created` first. The user message is persisted before the
model call (durable on failure); the assistant message stores accumulated text + `toolCalls`.

## 4. Automated tests
`apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts` (8 cases). Run:
```bash
pnpm -C apps/server exec jest src/integrations/ai/chat/ai-chat.service.spec.ts
```
Covers: chat create scoping; `getChatInfo` NotFound; `updateTitle`; `assertEnabled` Forbidden
when the toggle is off; `streamSend` not-configured error event; new-chat happy path (emits
`chat_created` + `content` + `done`, persists user then assistant message, auto-titles);
tool-loop (emits `tool_call`/`tool_result`, persists `toolCalls` with results); model failure
→ retryable `error` event. The `ai` SDK (`streamText`) is mocked, so no network/model needed.

Build + lint:
```bash
pnpm -C apps/server run build
pnpm -C apps/server exec eslint "src/integrations/ai/**/*.ts" "src/database/repos/ai-chat/**/*.ts"
```

## 5. Manual / human testing (needs a running stack + configured provider)
1. **Enable**: toggle on AI Chat in Settings → AI. Confirm the chat UI is reachable.
2. **Basic chat**: send "Hello" → reply streams in; refresh → the chat + both messages persist.
3. **History/title**: the sidebar shows the chat; title matches the first message; rename it →
   persists. Search for a word from a message → the chat is found.
4. **Tool loop** (needs embeddings): ask something answerable from a wiki page (e.g. "What does
   our onboarding doc say about X?"). Expect a `search_workspace` tool step to render, then a
   grounded answer. Reload → the tool call is still shown on the assistant message.
5. **Page context**: open a chat from a page (or @mention a page) and ask about its content →
   the answer reflects that page. Verify a page in a space you **cannot** access is **not**
   used (access control).
6. **Attachment**: upload a file in a new chat (no chatId yet) → returns an id; send a message →
   the file becomes linked to the chat (`attachments.ai_chat_id` set). Delete the chat → its
   attachments are cleaned up.
7. **Disabled/config gate**: turn the toggle off → `send`/`create` return 403
   ("AI Chat is not enabled"). Unconfigured provider → `send`/`create` return 400
   ("AI is not configured on this server") before an SSE stream starts.
8. **Access control**: a second user cannot load, send to, delete, or upload to the first
   user's chat (404 "Chat not found").

## 6. Notes / limits
- **Attachment content is not yet fed to the model.** B3.4 stores + links chat files; reading
  their text into the prompt depends on the attachment text-extraction feature (DOCX/PDF) and
  is a follow-up. `attachmentIds` are accepted and linked, not yet summarized.
- The tool set is currently `search_workspace` only; `get_page` and write-actions are future
  work. The loop is bounded to 6 steps (`stopWhen: stepCountIs(6)`).
- The AI provider is **env-based** today. When the AI Provider base-URL UI ships, chat will
  inherit the UI-configured provider with no code change (it resolves through the same
  `AiProviderService`).
- Chats are **per-creator**; there is no sharing of a chat between users.
