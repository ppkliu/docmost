# AI Provider Settings in the UI (set base URL / key / model) + AI Chat — Design

> Status: **DESIGN / ready to implement**. Goal: let an admin configure an **OpenAI-compatible**
> (or other) AI provider from the **frontend** — enter a **base URL** (+ API key + model) and AI
> features turn on **without editing env or restarting**. Plus continue the **AI Chat** backend (E8).

## 1. Current state (verified)
- AI provider config is **env-only**: `AI_DRIVER`, `OPENAI_API_URL`, `OPENAI_API_KEY`,
  `AI_COMPLETION_MODEL`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIMENSION`, read by
  [`AiProviderService`](../../apps/server/src/integrations/ai/ai-provider.service.ts) from
  [`EnvironmentService`](../../apps/server/src/integrations/environment/environment.service.ts).
- The AI settings UI ([`ai-settings.tsx`](../../apps/client/src/ee/ai/pages/ai-settings.tsx)) has
  **only toggles** (`generativeAi`, `aiSearch`) + a read-only MCP URL. **No base-URL / key / model
  inputs.** `GET /api/ai/config.configured` = server env configured AND the workspace toggle.
- Consequence: today you must set server env vars and **restart**; you cannot "just enter a URL".

## 2. Goal
Add a **workspace-level AI provider config** stored in `workspaces.settings.ai.provider`, which
**overrides env per field**, so admins configure AI from *Settings → AI* and it takes effect
immediately.

## 3. Design

### 3.1 Storage
`settings.ai.provider` (jsonb):
```jsonc
{ "driver": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "sk-…",          // secret — never returned to the client
  "completionModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDimension": 1536 }
```
New repo method `WorkspaceRepo.updateAiProvider(workspaceId, provider)` (jsonb merge into
`settings.ai.provider`, like the existing `updateAiSettings`).

### 3.2 Resolver (the keystone)
`AiProviderService`:
- `resolveConfig(workspaceSettings)` → effective config = `settings.ai.provider.<field> ?? env.<field>`
  per field (so a partial UI config still falls back to env).
- `completionModel(cfg?)` / `embeddingModel(cfg?)` take a resolved config (default = env), building
  the SDK model from `cfg.driver/baseUrl/apiKey/model`.
- `isConfigured(cfg)` / `isEmbeddingConfigured(cfg)` evaluate the resolved config.

Thread the workspace through the call sites (each already has `@AuthWorkspace()`):
- `AiService.generate/streamGenerate(…, workspaceSettings)` → pass resolved cfg to `completionModel`.
- `AiAnswerService.retrieve/streamAnswer(…, workspaceSettings)` → resolved cfg for embed + chat.
- `AiIndexingService` (queue) already loads the workspace row in `isEnabled` → read
  `settings.ai.provider` there for `embeddingModel`.

### 3.3 Endpoints
- `POST /api/ai/settings` (admin, `Feature.AI`) `{ driver?, baseUrl?, apiKey?, completionModel?,
  embeddingModel?, embeddingDimension? }` → `updateAiProvider`. Empty `apiKey` = keep existing.
- `GET /api/ai/config` extended → `{ configured, availableActions, provider: { driver, baseUrl,
  completionModel, embeddingModel, embeddingDimension, hasApiKey } }` — **apiKey masked**
  (`hasApiKey: boolean`, never the value). `configured` = resolved config valid (env **or** workspace).

### 3.4 Security
- `apiKey` is a secret: stored in `settings.ai.provider.apiKey`, **never** serialized back to the
  client (the config + workspace reads must strip it). Consider encrypting at rest later
  (`APP_SECRET`). Admin-only write; CASL `WorkspaceCaslAction.Manage`.

### 3.5 Frontend (the "place to set base URL")
New section in `ai-settings.tsx` (admin): driver `Select`
(`openai|openai-compatible|gemini|ollama`), **Base URL** `TextInput`, **API key** `PasswordInput`
(shows "•••• set" when `hasApiKey`), completion model, embedding model + dimension. Save →
`POST /api/ai/settings` → refetch `/ai/config`. Show a "Connected / Not configured" badge driven by
`configured`. The existing generative/search toggles stay; they now light up once a provider is set.

## 4. Phasing
- **P1 (backend):** resolver + `completionModel(cfg)`/`embeddingModel(cfg)` + `updateAiProvider`
  repo + `POST /api/ai/settings` + masked `GET /api/ai/config` + thread workspace through
  `AiService`/`AiAnswerService`/`AiIndexingService`. Unit tests: `resolveConfig` field-merge,
  masking. *(fully offline-verifiable)*
- **P2 (frontend):** the settings form + service + badge.
- **P3:** optional encrypt `apiKey` at rest; per-workspace model validation.

## 5. AI Chat (E8) — continue
Separate workstream (see [EE plan](./docmost-ee-features-oss-plan.md) E8): `/api/ai/chats/*`
(create/list/info/update/delete/search/upload + `send` SSE tool-loop over `ai_chats`/
`ai_chat_messages`) matching the client contract
([`ai-chat.types.ts`](../../apps/client/src/ee/ai-chat/types/ai-chat.types.ts)). It will use the
**same resolved provider config** from §3.2 for its `chatModel()`. Build after P1 so chat inherits
the UI-configured provider. Phases: B3.1 chat CRUD → B3.2 streamed send → B3.3 tool-calling
(reuse MCP tools + RAG) → B3.4 attachment upload.

## 6. Verification
- Unit: `resolveConfig` (workspace overrides env, partial falls back); `/ai/config` never leaks
  `apiKey`; `isConfigured` reflects resolved config.
- Live (running stack): in *Settings → AI*, enter an OpenAI-compatible base URL + key + model →
  toggle generative on → use Ask AI in the editor → streamed result, no server restart. Then enable
  AI Search → ask a question → grounded answer.
