# E9 — AI Provider Settings in the UI — Usage & Testing Manual

> Status: **implemented (OSS)**, extended by **E9.1** (OpenAI-compatible redesign, modeled on
> open-notebook's Settings → API Keys). Admins configure the AI provider (driver / base URL /
> API key / models) from *Settings → AI* — AI turns on **without editing server env or
> restarting**. The workspace config overrides server env **per field**, so a partial UI config
> still falls back to env. Powers Ask AI, AI Search, and AI Chat through the same resolver.
> Design: [docmost-openai-compatible-redesign.md](../design/docmost-openai-compatible-redesign.md).

## 1. What it does
- Stores a per-workspace provider override in `workspaces.settings.ai.provider`.
- `AiProviderService.resolveConfig(settings)` merges that override over env, field by field; the
  api-key / base-url env source is chosen by the resolved driver (Google AI -> Google AI key, ollama -> OLLAMA
  url, otherwise OPENAI key/url).
- All AI paths build their model from the resolved config: Ask AI (`/ai/generate*`), AI Answers
  (`/ai/answers`), AI Chat (`/ai/chats/send` + the `search_workspace` tool), and the embeddings
  indexing pipeline.
- The **API key is a secret**: stored **encrypted at rest** (AES-256-GCM keyed off `APP_SECRET`,
  `enc:v1:` prefix; legacy plaintext values keep working and are re-encrypted on the next save),
  **never** returned to the client (only `hasApiKey: boolean`), and stripped from every endpoint
  that serializes the workspace row — `POST /users/me`, `POST /auth/setup`,
  `POST /workspace/info`, `POST /workspace/update` (shared `stripWorkspaceSecrets` helper). If
  `APP_SECRET` is rotated, stored keys resolve as unset (warning logged) — re-enter the key.
- **E9.1 additions** — connection test and model discovery against the *draft* form values
  (merged over stored config + env, so you can test before saving), base-URL normalization
  (trailing `/`, pasted `/models` / `/chat/completions` suffixes stripped; missing `/v1`
  detected and suggested), and explicit clear semantics (empty string clears a field override
  back to env; `clearApiKey: true` deletes the stored secret).

## 2. Usage

### Frontend (*Settings → AI*, admin, self-hosted)
The **AI provider** card above the toggles: select the provider, enter Base URL and API key, then
- **Fetch models** — lists the models the endpoint actually serves; both model fields become
  Autocomplete inputs (suggestions + free text). If the listing only works at `{baseUrl}/v1`, a
  banner offers **Use this URL** one-click apply.
- **Test connection** — per-target result rows (completion / embedding) with latency; the
  embedding test also verifies the returned vector dimension matches the configured one.
- **Save** — persists the config. A **Connected / Not configured** badge reflects whether a
  driver + completion model resolve.

Leave the API key blank to keep the stored one (the field shows "•••• saved" when a key is set);
**Remove stored key** clears the secret on the next save. Clearing any other field falls back to
env for that field. Base URL is disabled for Google AI; API key is disabled for Ollama. After
saving, the AI toggles (Generative / Search / Chat) light up with no restart.

### REST API (JWT auth)
| Endpoint | Body | Notes |
|---|---|---|
| `GET /api/ai/config` | — | `{ configured, availableActions, provider: { driver, baseUrl, completionModel, embeddingModel, embeddingDimension, hasApiKey, embeddingConfigured } }` — **apiKey never returned** |
| `POST /api/ai/settings` | `{ driver?, baseUrl?, apiKey?, clearApiKey?, completionModel?, embeddingModel?, embeddingDimension? }` | **admin only** (CASL `Manage` workspace `Settings`). Provided fields are merged; `""` (or `0` for the dimension) **deletes** the override (env fallback resumes); a blank/omitted `apiKey` keeps the stored secret; `clearApiKey: true` deletes it. `baseUrl` is normalized; `apiKey` is encrypted before storage. Returns `{ configured, provider }` (masked). |
| `POST /api/ai/settings/test` | same fields + `targets?: ["completion","embedding"]` | **admin only**. Tests the draft config (merged over stored + env) without saving — completion: 8-token generation; embedding: embeds "ping" and checks the dimension. Returns `{ success, results: [{ target, success, message, latencyMs }] }`. Errors are mapped (401→"Invalid API key", unreachable→"Cannot reach the server", 404→base-URL hint) and never echo secrets. |
| `POST /api/ai/settings/models` | same fields (draft) | **admin only**. Lists models from the endpoint: openai/openai-compatible `GET {base}/models`, ollama `GET {base}/api/tags`, Google AI `v1beta/models`. Returns `{ models: string[], normalizedBaseUrl? }` — the latter set when listing only succeeded after appending `/v1`. |

Resolution precedence per field: `settings.ai.provider.<field>` → env → empty.

## 3. Automated tests
```bash
pnpm -C apps/server exec jest src/integrations/ai src/core/workspace --maxWorkers=1
```
- `ai-provider.service.spec.ts` (9): resolveConfig merge/fallback/driver-source/lowercasing;
  `isConfigured` / `isEmbeddingConfigured`; **apiKey at rest** (decrypts encrypted keys, legacy
  plaintext passthrough, undecryptable → env fallback).
- `secret.util.spec.ts` (5): round-trip, random IV, plaintext passthrough, rotated-secret → null,
  corrupted blob → null.
- `ai-connection.service.spec.ts` (18): normalizeBaseUrl cases; per-target test results,
  dimension mismatch, 401/unreachable mapping, no-embedding-model guard, bearer-token redaction;
  discovery per driver (openai-compatible auth header, `/v1` fallback suggestion, ollama tags,
  Google AI prefix strip, empty base URL).
- `workspace.service.spec.ts` (2): `stripWorkspaceSecrets` removes `settings.ai.provider.apiKey`
  from workspace responses (leak regression — applied at `/users/me`, `/auth/setup`,
  `/workspace/info`, `/workspace/update`) and leaves other settings untouched. *(Replaces the
  pre-existing auto-generated stub, which failed DI and never passed.)*

Suites: ai + workspace = **65 tests green**. Server `tsc --noEmit` + eslint green; client
typecheck (`pnpm -C apps/client exec tsc --noEmit`) green. (Client eslint is broken repo-wide —
missing `@tanstack/eslint-plugin-query` module in node_modules — unrelated to this change.)

## 4. Manual / human testing (needs a running stack)

> **Live-verified (2026-06-12)** against a fresh dev stack (`docker-compose.dev.yml`, port 3011,
> clean DB) and a real vLLM endpoint (`http://10.130.10.2:30015/v1`, `qwen3.6-27b-fp8`):
> - API: `/ai/settings/models` listed the served model; base URL without `/v1` returned
>   `normalizedBaseUrl` suggestion; `/ai/settings/test` → completion success (419ms real
>   generation), wrong-port draft → clean "Timed out after 10s" failure row; saved `apiKey`
>   stored as `enc:v1:…` in `workspaces.settings` (checked in psql); stored key decrypted and
>   reused for a follow-up test; `clearApiKey` removed the jsonb field; `""` removed the
>   `baseUrl` override.
> - Leak fix: `/users/me` and `/workspace/info` responses contain **no**
>   `settings.ai.provider.apiKey` while the DB holds the encrypted value.
> - UI (Playwright): card renders with Fetch models / Test connection / Remove stored key;
>   the `/v1` hint and the "Models were found at …/v1 instead" banner appeared for a bare
>   host:port URL; **Use this URL** applied it; Test connection rendered the green
>   "completion — Connected (qwen3.6-27b-fp8) (419ms)" row; Save persisted the normalized URL.
> - Not covered live: non-admin 403 (needs a second account; the CASL gate is the same
>   `assertAdmin` path unit-covered elsewhere), embedding test (no embedding model served by
>   this vLLM instance — dimension-mismatch path is unit-tested).
1. As an admin on self-hosted, open *Settings → AI*. The **AI provider** card shows; the badge is
   "Not configured" on a fresh install.
2. Select **OpenAI-compatible**, enter the **Base URL** (e.g. a vLLM/LM Studio endpoint) →
   **Fetch models** → the model fields suggest the served models. Enter a base URL *without*
   `/v1` → the "Models were found at … instead" banner appears → **Use this URL** applies it.
3. **Test connection** → green completion row with latency. With an embedding model set, the
   embedding row verifies the dimension (set a wrong dimension → red row showing both numbers).
4. **Save**. The badge becomes **Connected**; no restart needed. Reopen the page → fields are
   prefilled; the API key shows "•••• saved" (not the value). Confirm `GET /api/ai/config`
   contains `provider.hasApiKey: true` and **no** `apiKey`, and that `POST /api/workspace/info`
   contains **no** `settings.ai.provider.apiKey` (leak fix).
5. In the DB, `workspaces.settings->ai->provider->apiKey` starts with `enc:v1:` (encrypted at
   rest).
6. Toggle **Generative AI** on → use *Ask AI* in the editor → streamed result via the UI provider.
7. Add **embedding model + dimension** → Save → enable **AI Search** → ask a question → grounded
   answer. AI Chat's `search_workspace` tool now works too.
8. Save again leaving the API key blank → the stored key is preserved (AI still works). Click
   **Remove stored key** → Save → `hasApiKey` flips false; the env key (if any) takes over.
9. As a **non-admin**, `POST /api/ai/settings`, `/settings/test`, and `/settings/models` all
   return 403; the settings page is admin-only.

## 5. Notes / limits
- Env remains a valid config source; the UI override only replaces the fields you set. Clearing a
  field in the UI deletes that override so the env value (if any) takes over.
- Rotating `APP_SECRET` makes stored keys undecryptable: they resolve as unset (warning in the
  server log) — re-enter the key in the UI. Legacy plaintext keys keep working and are encrypted
  on the next save.
- The connection test makes one real (tiny) completion/embedding call — on paid providers this
  costs a few tokens.
- i18n strings for the new UI controls are English-only for now (same as the rest of the card).
