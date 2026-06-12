# Docmost OSS Feature Tasks (from design specs)

Consolidates the design docs into actionable tasks, implemented one-by-one with tests
(build + lint + unit tests each), with a user manual at the end. Source specs:
[agent-api](./docmost-agent-api-spec.md) · [ai-features](./docmost-ai-features-design.md) ·
[mcp](./docmost-mcp-design.md) · [bulk-import](./docmost-bulk-import-design.md) ·
[agent-skills](./docmost-agent-skills-design.md).

Legend: ✅ done & verified · 🟡 partial · ⬜ todo

## 1. API keystone (personal API keys + REST auth)
- ✅ `api_keys` Kysely repo + DatabaseModule registration
- ✅ `ApiKeyService` (create/list/update/revoke/validateApiKey) + controller + DTOs + module
- ✅ `jwt.strategy` OSS fallback; unit tests (10); build+lint
- ⬜ (later) admin "restrict API keys to admins" toggle

## 2. MCP server
- ✅ `/mcp` Streamable HTTP controller, bearer API-key auth, `settings.ai.mcp` gate
- ✅ read tools: get_current_user, list_spaces, search_pages, get_page, list_recent_pages
- ✅ write tools: create_page, update_page; unit tests (6); build+lint
- ⬜ T2.1 more tools: get_space, create_space, update_space, list/add/update comments, search_attachments, list_members, move_page, duplicate_page
- ✅ T2.2 client config docs (code editor / desktop clients) — covered in [docs/USER-MANUAL.md](../USER-MANUAL.md) §3.2 and [skills/README.md](../../skills/README.md)

## 3. Bulk file import
- ✅ `buildBulkImportZip` util + `ImportService.importBulkFiles` + `POST /pages/import-files`
- ✅ unit tests (6); build+lint; design doc

## 4. AI — Ask AI (generative editor actions) — "B1"
- ✅ T4.1 `AiProviderService` over Vercel AI SDK (openai / openai-compatible / google-ai / ollama) by `AI_DRIVER`
- ✅ T4.2 prompt templates per `AiAction` (improve/fix/longer/shorter/simplify/continue/explain/summarize/change_tone/translate/custom)
- ✅ T4.3 `AiService` + `AiController`: `POST /api/ai/generate` (sync), `POST /api/ai/generate/stream` (SSE), `GET /api/ai/config`
- ✅ T4.4 permission gate (`settings.ai.generative`), wired `AiModule`, prompt unit tests (6), build+lint

## 5. AI — AI Answers (semantic/RAG search) — "B2"
- ✅ T5.1 pgvector migration: `CREATE EXTENSION vector` + `page_embeddings(vector(dim))` + HNSW (cosine) index; `embedding.util` chunking + `AiProviderService.embeddingModel()`
- ✅ T5.2 ingestion: `AiIndexingService` (chunk → `embedMany` → `EmbeddingRepo.replacePageChunks`) + `AiQueueProcessor` consuming page/workspace AI_QUEUE jobs (gated by config + workspace `ai.search`)
- ✅ T5.3 re-embed on save/create/move + delete on delete; workspace backfill/teardown on `aiSearch` toggle (enqueue already in workspace.service; processor added)
- ✅ T5.4 `POST /api/ai/answers` (SSE): embed query → CASL-scoped cosine ANN search → grounded `streamText` + deduped `sources[]` matching the client contract
- ✅ T5.5 unit tests: chunking (5), indexing gating (8), answer retrieval/dedup (3); build+lint green. Live (ANN over real pgvector) needs a running stack with pgvector installed.

## 6. Feature-gate / entitlement unlock (makes MCP + AI UI toggles usable)
- ✅ T6.1 grant OSS-implemented features for self-hosted in **`license-check.service.ts`**
  (single source of truth — feeds both `resolveFeatures` for the entitlements endpoint and
  `hasFeature` for the enable-gate). Current self-hosted unlock:
  `SELF_HOSTED_OSS_FEATURES = [API_KEYS, MCP, AI, COMMENT_RESOLUTION]`. Features still missing
  an OSS backend stay license-gated until their slice lands. Unit tests cover the unlock list.
- ⬜ T6.2 live: verify admin Settings shows the API-keys + MCP entries and the MCP toggle enables
  (needs a running stack)

## 7. Agent REST API gateway (Python, Workstream A)
- ⬜ T7.1 package skeleton (`tools/docmost-gateway`): config, errors, auth (Bearer GATEWAY_API_KEY)
- ⬜ T7.2 `DocmostClient` (cookie login, 401 re-login, unwrap envelope)
- ⬜ T7.3 `/v1` routes (pages CRUD, search, attachments, import) → FastAPI OpenAPI
- ⬜ T7.4 self-test harness (skills + OpenAI-compatible agent + deterministic scenario)
- ⬜ T7.5 pytest (httpx MockTransport + TestClient)

## 8. Agent Skills & Auto-Organize (A3 b/c/e/f/g/h, Workstream D)
> Model: **thin server / smart agent** — Docmost provides API only (store + relay); the external
> agent's own LLM does summarize/tag/classify/dedup/code→wiki and writes results back. No
> server-side LLM in this flow. See [agent-skills design](./docmost-agent-skills-design.md) §1.1 RACI.
- 🟡 D1 tag + summary **store**: tags = **native labels** (`labels`/`page_labels` + `/api/pages/labels/*` + client picker — ✅ already in OSS, no work); summary ✅ **done** (`pages.summary` migration + `page.repo` baseFields + `update-page.dto` + `page.service.update`; build+lint green). Optional left: summary in page-header UI; label `origin` flag (A3 b/c)
- 🟡 D2 organize task + status: ✅ **server done** — `organize_tasks`/`organize_events` + repo + `OrganizeService`/`OrganizeController` (`create/info/by-token/update/events/list`) + `statusUrl`; 8 unit tests + build+lint green. Left: client `/organize/:token` status page (with D3 UI) (A3 f)
- ✅ D3 realtime relay: Redis pub/sub publish (`OrganizeService`) + SSE `GET /api/organize-tasks/:id/stream` + client `useOrganizeStream`/`OrganizePanel` + status page `/organize/:shareToken`; server build+lint+22 tests green, client typecheck green. Live SSE/UI pending a running stack (A3 g)
- ✅ D4 dedup primitives: `page_content_hashes` + `dedup.util` (normalize+sha256) + `DedupService.analyze` (cluster, keep-oldest) + `POST /api/dedup/{analyze,resolve}` (resolve soft-deletes via `pageRepo.removePage`); 11 unit tests + build+lint green. Hashes computed on analyze; optional on-write refresh later (A3 e — agent decides, native history = versions)
- ✅ D5 Agent Skill bundle: `skills/docmost.skills.json` (18 skills) + `RECIPE.{organize,code-to-wiki}.md` + `skills/docmost/SKILL.md` (openclaw) + `README.md`; **MCP tools added** (`list_labels`/`add_page_labels`/`set_page_summary`/`dedup_analyze`/`organize_create|report|close`, 9 MCP tests, build+lint green). ✅ filtered OpenAPI doc (`skills/docmost.openapi.json`, 20 ops). Optional left: per-skill openclaw split (A3 headline + h as recipe)
- ✅ D6 manual upload UI: `BulkUpload` + `BulkUploadModal` (drag-drop -> import-files -> organize task + live panel + share link), mounted as "Bulk upload & organize" in the space sidebar menu (next to Import, gated by canManagePages); client typecheck green. Optional later: review queue (A3 b-1)

## 9. Documentation
- ✅ T8.1 **User manual** (使用說明書): [docs/USER-MANUAL.md](../USER-MANUAL.md) — A3 a–h, API keys, REST + MCP usage, skill bundle/recipes, bulk upload UI, status page, and a live smoke-test checklist

## 10. EE features → OSS program (plan: [docmost-ee-features-oss-plan.md](./docmost-ee-features-oss-plan.md))
- ✅ E0 open AI settings by default: `Feature.AI` granted for self-hosted (`SELF_HOSTED_OSS_FEATURES`)
- ✅ E1 Resolve comments (S): `POST /api/comments/resolve` + `CommentService.resolveComment` + `comment:resolution` unlock; 2 unit tests, build+lint green. Manual: [docs/manuals/E1-resolve-comments.md](../manuals/E1-resolve-comments.md)
- ✅ E2 DOCX import (S–M): OSS `processDocx` via `mammoth` → `processHTML`; unlock `import:docx`. Manual: [docs/manuals/E2-docx-import.md](../manuals/E2-docx-import.md)
- ✅ E3 Audit logs (M): OSS `AuditService` recording into `audit` + `POST /audit` + retention endpoints + unlock `audit:logs`. Manual: [docs/manuals/E3-audit-logs.md](../manuals/E3-audit-logs.md)
- ✅ E4 Templates (M): OSS `TemplateModule` over `templates`/`TemplateRepo`; unlock `templates`. Manual: [docs/manuals/E4-templates.md](../manuals/E4-templates.md)
- ⬜ E5 Attachment full-text (M) + PDF import (M): shared text-extraction layer; unlock `attachment:indexing`/`import:pdf`
- ⬜ E6 Page verification & approval (M): OSS module over `page_verifications`; unlock `page:verification`
- ✅ E7 Page-level permissions: enforcement + repo + client modal already existed; added the missing management API — `PagePermissionService`/`PagePermissionController` (7 endpoints under `/pages/*` matching the client contract: restrict/remove-restriction/add-permission/remove-permission/update-permission/permissions/permission-info), manage-rights model (space admin always manages for lockout recovery; writers on nearest restriction otherwise), last-writer guards, workspace-membership validation + unlock `page:permissions`. 14 unit tests + license unlock test; server tsc/lint green; **live-verified** on the dev stack (full endpoint pass incl. inheritance banner + group round-trip). Manual: [docs/manuals/E7-page-permissions.md](../manuals/E7-page-permissions.md)
- ✅ E9 AI provider settings in UI (set base URL/key/model): workspace `settings.ai.provider` resolved over env (`AiProviderService.resolveConfig`, per-field merge) + `WorkspaceRepo.updateAiProvider` + admin `POST /api/ai/settings` + masked `GET /api/ai/config` (apiKey never returned) + threaded through Ask AI / AI Answers / AI Chat / indexing + client provider form (`ai-provider-settings.tsx`) with Connected badge. 6 provider unit tests (37 AI tests total) + server build/lint + client typecheck green. Manual: [docs/manuals/E9-ai-provider-settings.md](../manuals/E9-ai-provider-settings.md). Plan: [docmost-ai-provider-ui-design.md](./docmost-ai-provider-ui-design.md)
- ✅ E9.1 OpenAI-compatible redesign (open-notebook-style test/discover/encrypt): `AiConnectionService` (normalizeBaseUrl + per-target connection test w/ embedding-dimension check + model discovery incl. `/v1` suggestion) + admin `POST /api/ai/settings/test` & `/api/ai/settings/models` (draft-over-stored-over-env merge) + apiKey **encrypted at rest** (AES-256-GCM via APP_SECRET, `enc:v1:` prefix, legacy plaintext lazy-upgrade) + explicit clear semantics (`""` clears a field override, `clearApiKey` removes the secret) + **fixed apiKey leak** at all four workspace-serializing endpoints — `/users/me`, `/auth/setup`, `/workspace/info`, `/workspace/update` (shared `stripWorkspaceSecrets` in `common/helpers/workspace-secrets.ts`) + client card redesign (Fetch models → Autocomplete, Test connection result rows, base-URL suggestion banner, Remove stored key). 28 new unit tests (65 total across ai+workspace suites) + server tsc/lint + client typecheck green. **Live-verified** on a fresh dev stack against a real vLLM endpoint: discover incl. `/v1` suggestion, test (success + timeout mapping), `enc:v1:` in DB, stored-key decrypt reuse, clear semantics, `/users/me`+`/workspace/info` leak-free, and the full UI flow via Playwright (manual §4). Design: [docmost-openai-compatible-redesign.md](./docmost-openai-compatible-redesign.md) · Gap analysis: [docmost-openai-compatible-gaps.md](./docmost-openai-compatible-gaps.md)
- ✅ E8 AI Chat / Assistant (L): `/api/ai/chats/*` + tool-calling SSE loop over `ai_chats`/`ai_chat_messages` (B3.1 CRUD, B3.2 streamed send + persistence + auto-title, B3.3 `search_workspace` + page-context grounding + jsonb tool-call persistence, B3.4 chat attachment upload/link/cleanup). Manual: [docs/manuals/E8-ai-chat.md](../manuals/E8-ai-chat.md). Verification: server build + lint + 8 AI chat unit tests green. Uses the current env-backed `AiProviderService`; E9 can later swap in UI-resolved provider config.

## 11. Enterprise KB goals (目标2/目标3 — approved roadmap 2026-06-12)
> 目标2: enterprise KB entry — domain/workspace permission partitioning + backend links to
> Cognee / LLM-Wiki. 目标3: Hermes integration — user knowledge auto-submitted to the wiki.
> Priority: **E7 → K1+K2 → H1+H2 → K3+K4 (design first)**; E6/H3/T7 deferred until the
> integration mode is settled.
- ✅ E7 → tracked in §10 (page-level permissions; the permission half of 目标2)
- ✅ K1 KB connector settings: `AiKbService` over `settings.ai.knowledgeBases[]` ({ id, type: cognee|llm-wiki|custom, name, baseUrl, apiKey, searchPath?, enabled }) — E9.1 pattern reused: AES-GCM key at rest, masked responses (`hasApiKey`), `stripWorkspaceSecrets` extended to KB keys, admin-only `GET/POST /ai/kb` + `kb/delete` + `kb/test` (stored-or-draft), `WorkspaceRepo.updateAiKnowledgeBases`, client card (`ai-kb-settings.tsx`) with add/edit modal + enable switch + test. **Live-verified**: CRUD, stored-key decrypt test (14ms), 401 mapping, `enc:v1:` in DB, no key in `/users/me`
- ✅ K2 chat federation: per-enabled-connector `search_<name>` tools in `AiChatService.buildTools()` (sanitized names, disabled connectors skipped, failures degrade to `{error}` instead of aborting the turn; per-type adapters cognee `/api/v1/search` · llm-wiki `/api/search` · custom `searchPath`). **Live-verified end-to-end**: real LLM (qwen3.6 via vLLM) invoked `search_mock_kb` and streamed the attributed tool result. 11 new unit tests (87 total ai+workspace) + server/client tsc + eslint green
- ✅ K3 sync pipeline (v1 rebuild-per-space, see design §6): connector `sync` flag (DTO + card checkbox + badge) · `KbSyncService` (debounced `KB_SYNC_SPACE` rebuild jobs, `KB_TEARDOWN`, backfill-on-enable, inline teardown on delete) · cognee ingest adapters (`add`/`cognify`/`listDatasets`/`deleteDatasetByName`) · `AiQueueProcessor` fan-out from page events. 13 unit tests; **live verification pending a real Cognee deployment**
- ✅ K4 scope model: **K4.2** embedding pipeline audit found AI Answers filtered by space only — **E7-restricted pages now excluded/evicted from pgvector and from KB export** (leak closed); **K3.3** restrict/unrestrict re-enqueues subtree indexing (subtree computed before deletion on unrestrict); **K4.1** synced cognee chat tools scoped to the caller's space datasets (`docmost_<ws>_<space>`), empty memberships short-circuit. 7 unit tests across indexer/page-access/chat. 96 tests green in ai+page-access suites; server/client tsc + eslint clean
- ✅ H1 attribution mapping: `X-On-Behalf-Of: <email>` on API-key requests (`jwt.strategy.applyOnBehalfOf`, OSS + EE key paths) — only admin/owner-owned keys may delegate; unknown/disabled targets and member keys → 401 (fail loud, never mis-attribute); target's own CASL applies (no escalation); `req.raw.impersonatorId` + log line for audit. Per-user API keys remain the zero-config alternative. 5 unit tests; **live-verified** (valid delegation → target identity on `/users/me`; unknown email → 401). Design: [docmost-hermes-governance-design.md](./docmost-hermes-governance-design.md)
- 🟡 H2 review queue: **phase 0 available now by convention** (`needs-review` native label + reviewer filter, zero code, documented in the design); **phase 1 designed** (`pages.reviewStatus` pending/approved/rejected, indexing/sync exclusion for pending, review-queue + approve/reject endpoints, client queue/badge — tasks H2.1–H2.5 in the design doc)
- Deferred: E6 (verification), H3 (on-write dedup refresh), T7 (Python gateway — only if Hermes does not consume REST/OpenAPI directly)

## 12. 未完成工作總表 (Pending work, consolidated 2026-06-12)
> Single source of truth for everything left open across the 目标2/目标3 program. Items also
> noted in their own design docs/manuals link back here.

### Needs implementation
- ⬜ **H2 phase 1** review queue — `pages.reviewStatus` (pending/approved/rejected), `requestReview` on REST/MCP create, indexing/sync exclusion for pending pages, `POST /pages/review-queue` + `POST /pages/review` (approve|reject), client queue page + editor badge, skills-recipe update. Tasks H2.1–H2.5 in [docmost-hermes-governance-design.md](./docmost-hermes-governance-design.md). Until then: phase-0 `needs-review` label convention.
- ⬜ **K3.4 full sync status** — persist `lastSyncAt`/`lastError` per connector and show on the KB card (today: log lines + the "sync" badge only).
- ⬜ **K3 incremental upserts** — optimization over the v1 rebuild-per-space strategy ([design §6](./docmost-kb-federation-design.md)); also fixes the hard-delete residue (a hard-deleted page's content lingers in the space dataset until the next rebuild trigger).
- ⬜ **H1 follow-ups** — audit event for delegated writes (uses `req.raw.impersonatorId`, needs an upstream-compatible `AuditEvent` name); optional per-key delegation allowlist (`api_keys.delegationScope`).
- ⬜ **E7 audit events** — restrict/permission changes are not audit-logged (no matching `AuditEvent` values upstream).
- ⬜ **i18n batch** — none of the AI/KB/page-permission UI strings (incl. pre-existing E9 card strings) are in `public/locales/*/translation.json`; i18next falls back to English. Do as one batch.

### Needs verification (implementation done, environment missing)
- ⬜ **K3 live against a real Cognee** — the `/api/v1/{add,cognify,datasets,search}` adapter shapes are unit-tested but unverified against a deployed Cognee version; run [kb-federation design §5](./docmost-kb-federation-design.md) checklist (backfill → member/non-member scoped search → restrict eviction). Adapter isolated in `AiKbService` if paths differ.
- ⬜ **E7 UI pass** — API contract live-verified; the share-modal permission tab not yet exercised via browser (manual §5 of [E7](../manuals/E7-page-permissions.md)).
- ⬜ **E9.1 minor live gaps** — non-admin 403 on AI settings endpoints (needs a second account; unit-covered) and a live embedding round-trip (the vLLM box serves no embedding model; dimension-mismatch path unit-covered).

### Deferred by decision (revisit when the integration mode is settled)
- ⬜ E6 page verification · ⬜ H3 on-write dedup refresh · ⬜ T7 Python gateway (only if Hermes will not consume REST/OpenAPI + API key directly)
- ⬜ T2.1 extra MCP tools · ⬜ T6.2 live entitlement check · ⬜ E5 attachment full-text + PDF import · ⬜ §1 admin "restrict API keys to admins" toggle · ⬜ §7 T7.1–T7.5 gateway tasks

### Housekeeping
- ⬜ **Commit the working tree** — everything from E9.1 onward is uncommitted (E9.1 provider redesign + G7 leak fix + E7 + K1/K2 + H1 + K3/K4 + docs/manuals). Suggested split: `fix` (G7 + K4.2 leak closures) → `feat` (E9.1) → `feat` (E7) → `feat` (K1/K2/K3/K4) → `feat` (H1) → `test` → `docs`.
- ⬜ **Dev-stack cleanup** — verification stack still running: `docmost-dev` compose (ports 3011/5173/25433/26379, data in `data/dev/`) and the mock KB (`node /tmp/mock-kb.js`, port 18099). Stop with `docker compose --env-file .env.dev -f docker-compose.dev.yml down` + kill the node process when no longer needed. The production instance (port 3010) was never touched and still runs the pre-change image — **redeploy it (`docker compose build && up -d`) to pick up the G7/K4.2 security fixes once committed**.

## Execution order
3 ✅ → 1 ✅ → 2 ✅ → **4 (AI B1)** → 6 (entitlement) → 5 (AI B2) → 2.1/2.2 (MCP extras) → 7 (gateway) → D1→D2→D3→D4→D5→D6 → 8 (manual) → **E0 ✅ → E1 ✅ → E8 ✅ → E2→E3→E4→E5→E6→E7** (EE→OSS).
Workstream D depends only on C0 ✅ (API-key) + bulk-import ✅; it is **independent of the server AI module (B)** because the agent brings its own LLM.
