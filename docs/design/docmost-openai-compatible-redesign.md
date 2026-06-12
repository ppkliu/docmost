# OpenAI-Compatible Provider 設定重新設計（參考 open-notebook settings/api-keys）

> Status: **DESIGN → implementing**. Builds on the shipped E9 base
> ([docmost-ai-provider-ui-design.md](./docmost-ai-provider-ui-design.md)): workspace
> `settings.ai.provider` overrides env per field. This doc closes the gaps found by comparing
> docmost against open-notebook's Settings → API Keys design
> (lfnovo/open-notebook: `api/routers/credentials.py`, `api/credentials_service.py`,
> `frontend/.../settings/api-keys/page.tsx`).

## 1. Reference analysis — what open-notebook does that docmost lacks

open-notebook's api-keys page is built around three interactions per credential, all of which
E9 is missing:

| open-notebook | Mechanism | docmost E9 today |
|---|---|---|
| **Test connection** (`POST /credentials/{id}/test`) | openai_compatible → `GET {base_url}/models`; other providers → 1-token SDK call; per-provider error mapping (401→"Invalid API key", model-not-found→still success) | none — admin saves blind, first error appears in Ask AI |
| **Discover models** (`POST /credentials/{id}/discover`) | `GET {base_url}/models` (ollama: `/api/tags`) → checklist → register; custom-name fallback when listing misses a model | admin must hand-type `completionModel` / `embeddingModel` |
| **Encrypted secrets** | Fernet via `OPEN_NOTEBOOK_ENCRYPTION_KEY`; API never returns the key (only `has_api_key`) | masked in responses ✅ but stored **plaintext** in `workspaces.settings` jsonb |
| URL handling | `models_endpoint()` tolerates trailing `/` and `/models` suffix | raw string saved as-is; `/v1` confusion (P7 in the open-notebook analysis) is inherited |

Deliberately **not** adopted (docmost ≠ open-notebook in scope):
- *Multiple credentials per provider + model registry tables.* Docmost has exactly one provider
  config per workspace with two model slots (completion/embedding). The registry/default-models
  machinery would add tables and UI for no current consumer. The per-field env merge already
  covers the "several sources" need.
- *Per-modality endpoint overrides* (`endpoint_llm/embedding/...`). Same reason; revisit if a
  real split-endpoint deployment shows up (the design leaves room: `settings.ai.provider` is
  jsonb, fields can be added without migration).

## 2. Goals

1. **Test before trusting** — a connection test that exercises the *draft* form values (not just
   the saved config), reporting completion and embedding separately.
2. **Pick, don't type** — model discovery from the endpoint feeding Autocomplete suggestions for
   both model fields (free text still allowed, like open-notebook's custom-model row).
3. **Normalize URLs** — one server-side normalizer used by save / test / discover.
4. **Encrypt the API key at rest** — AES-256-GCM keyed off `APP_SECRET`, transparent to readers,
   backward compatible with already-stored plaintext values.
5. **Explicit clear semantics** — admin can remove a stored override (incl. the secret) and fall
   back to env.

## 3. Backend design

### 3.1 New service: `AiConnectionService` (`integrations/ai/ai-connection.service.ts`)

Keeps probe/discover HTTP out of `AiProviderService` (which stays a pure config→SDK factory).

```ts
normalizeBaseUrl(url): string
// trim; strip trailing '/'; strip accidental '/models' | '/chat/completions' suffixes.
// Never invents '/v1' — suggestion only happens via discovery fallback (3.3).

testConnection(cfg: ResolvedAiConfig, targets?: ('completion'|'embedding')[])
  : Promise<AiTestResult[]>
// completion: AiProviderService.completionModel(cfg) → generateText({ maxOutputTokens: 8 })
// embedding:  AiProviderService.embeddingModel(cfg) → embed('ping')
//             + dimension check: warn-level failure when vector length ≠ cfg.embeddingDimension
// Each result: { target, success, message, latencyMs }. 10s timeout per target, run in parallel.
// Error mapping (as in open-notebook): 401/unauthorized → "Invalid API key";
// fetch failed/ECONNREFUSED → "Cannot reach <host>"; 404 on chat → hint about base URL.

discoverModels(cfg: ResolvedAiConfig): Promise<{ models: string[]; normalizedBaseUrl?: string }>
// driver-specific listing over global fetch (Node 22):
//   openai            GET {baseUrl || https://api.openai.com/v1}/models   (Bearer)
//   openai-compatible GET {baseUrl}/models                                 (Bearer if key)
//   ollama            GET {baseUrl}/api/tags                               → models[].name
//   google-ai         GET https://generativelanguage.googleapis.com/v1beta/models?key=...
//                     → models[].name stripped of the 'models/' prefix
// openai-compatible fallback: if {baseUrl}/models 404s and baseUrl has no path,
// retry {baseUrl}/v1/models; on success return normalizedBaseUrl = baseUrl + '/v1'
// (mirrors open-notebook's probe suggestion — server suggests, never rewrites silently).
```

### 3.2 Endpoints (`AiController`, both **admin-only** — drafts carry secrets)

```http
POST /api/ai/settings/test
{ ...AiSettingsDto (draft, all optional), targets?: ["completion","embedding"] }
→ { success, results: [ { target, success, message, latencyMs } ] }

POST /api/ai/settings/models
{ ...AiSettingsDto (draft, all optional) }
→ { models: ["qwen3-32b", ...], normalizedBaseUrl? }
```

Both resolve the effective config as **draft over stored over env** — the same merge the save
path uses, so "test then save" sees exactly what will run. A blank draft `apiKey` means "use the
stored secret" (so the admin can re-test without re-typing the key).

`POST /api/ai/settings` (existing) changes:
- run `normalizeBaseUrl` on `baseUrl` before persisting;
- encrypt `apiKey` before persisting (3.4);
- support clearing: a present-but-empty string (`""`) for a non-secret field **deletes** the
  stored override (env fallback resumes); a new boolean `clearApiKey: true` deletes the secret.
  (Today `""` is merged and happens to act as "fall back to env" only because resolve uses `||`;
  deleting the key makes the stored state match the intent.)

### 3.3 DTOs (`dto/ai-settings.dto.ts`)

```ts
class AiSettingsDto { ...existing; clearApiKey?: boolean }   // @IsBoolean @IsOptional
class AiTestDto extends AiSettingsDto { targets?: ('completion'|'embedding')[] }  // @IsIn(each)
```

### 3.4 Secret at rest (`integrations/ai/secret.util.ts`)

```
encryptSecret(plain, appSecret) → "enc:v1:" + base64(iv | tag | ciphertext)   // AES-256-GCM
decryptSecret(stored, appSecret) → plain
```
- Key = `sha256(APP_SECRET)`; random 12-byte IV per encryption.
- `decryptSecret` passes through values not starting with `enc:v1:` → already-stored plaintext
  keys keep working; they get encrypted on the next save (lazy upgrade, no migration).
- Decryption happens in `AiProviderService.resolveConfig` (the single choke point), so every
  consumer (Ask AI, Answers, Chat, indexing, test, discover) sees the plaintext transparently.
  `EnvironmentService` is already injected there; env-sourced keys are never encrypted.
- Decryption failure (APP_SECRET rotated) → log a warning and resolve the field as empty, so
  `hasApiKey` flips false and the UI shows "not set" instead of hard-failing every AI call.

### 3.5 Threading

No call-site changes: all AI paths already pass through `resolveConfig` (E9). Only the
controller (save/test/models) and the two new service files change.

## 4. Frontend design (`ee/ai/components/ai-provider-settings.tsx`)

```text
┌─ AI provider ────────────────────────────── [● Connected] ─┐
│ Provider          [ OpenAI-compatible ▾ ]                  │
│ Base URL          [ http://10.130.10.2:8000/v1     ]       │
│                   ⓘ usually ends with /v1                  │
│ API key           [ ••••  (saved — leave blank to keep) ]  │
│                                            [ Clear key ]   │
│ Completion model  [ qwen3-32b            ▾ ]  ← Autocomplete│
│ ── Embeddings (optional) ─────────────────────────────────  │
│ Embedding model   [ bge-m3               ▾ ]  Dim [ 1024 ] │
│                                                             │
│ [ Fetch models ]  [ Test connection ]            [ Save ]  │
│  ✓ completion — Connected (842ms)                           │
│  ✗ embedding — dimension mismatch: model returns 1024,      │
│                configured 1536                              │
└─────────────────────────────────────────────────────────────┘
```

- **Fetch models** → `POST /ai/settings/models` with current form values → fills the
  Autocomplete `data` for both model fields (Mantine 8 `Autocomplete`: suggestions + free text,
  replacing the removed creatable-Select — equivalent of open-notebook's discover checklist +
  custom-model row, collapsed into the input itself). When the response carries
  `normalizedBaseUrl`, show an inline hint with one-click apply.
- **Test connection** → `POST /ai/settings/test` with form values → per-target result rows
  (icon + message + latency), green/red, mirroring open-notebook's per-credential test plug.
  Embedding row only renders when an embedding model is set.
- **Clear key** button (visible when `hasApiKey`) sends `clearApiKey: true` on next save.
- Save flow unchanged otherwise; badge still derives from `GET /ai/config`.

Client service additions (`ai-provider-service.ts`): `testAiProvider(dto)`,
`discoverAiModels(dto)`; types in `ai.types.ts` (`AiTestResult`, `AiModelsResponse`).

## 5. Security notes

- Test/models endpoints are admin-gated (CASL `Manage` `Settings`) — they accept arbitrary URLs
  (SSRF surface) and can carry a draft key; same trust level as writing the settings.
- Responses never echo the key; test failure messages are sanitized (no auth header dumps).
- **Leak fix (found during this analysis)**: endpoints that serialize the workspace row return
  the whole `settings` jsonb — the E9-stored `apiKey` went to **every authenticated user** in
  plaintext. A full controller sweep found **four outlets**: `POST /users/me` (hit on every app
  load), `POST /auth/setup`, `POST /workspace/info`, `POST /workspace/update`. All four now pass
  through the shared `stripWorkspaceSecrets()` (`common/helpers/workspace-secrets.ts`), which
  deletes `settings.ai.provider.apiKey` before the response. The request-context workspace (used
  by `resolveConfig`) is loaded separately by middleware and is unaffected. Encryption (3.4) is
  the second line of defense — a missed outlet exposes only the `enc:v1:` blob.

## 6. Phasing & verification

- **P1 backend**: `secret.util` + `AiConnectionService` (normalize/test/discover) + DTOs +
  controller endpoints + encryption-in-resolve. Unit tests (offline, `fetch`/SDK mocked):
  normalize cases; discover per driver incl. `/v1` fallback; test success/401/timeout mapping;
  dimension mismatch; encrypt/decrypt round-trip + plaintext passthrough + bad-secret fallback;
  clear semantics in the controller merge.
- **P2 frontend**: service fns + redesigned card (Autocomplete, Fetch models, Test connection,
  Clear key, normalize hint). `tsc --noEmit` green.
- **Live checklist** (running stack): point at a vLLM/LM Studio endpoint → Fetch models lists
  ids → pick one → Test shows green completion → Save → Ask AI streams. Enter base URL without
  `/v1` → hint appears → apply → test green. Embedding dim mismatch → red row with both numbers.
