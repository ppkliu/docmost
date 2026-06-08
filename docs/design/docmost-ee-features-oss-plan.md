# Docmost EE features → OSS — Design & Implementation Plan

> Status: **PLAN / in progress**. The user asked to open the AI settings by default and to
> design + implement the EE-locked features below for the self-hosted OSS build. This doc audits
> each, defines the OSS approach, and sequences the work. The pattern throughout matches the
> already-shipped AI/MCP/API-key work: **tables + repos + client + feature flags already exist in
> OSS; the service logic `require()`s an absent `ee/*` module and throws "requires EE license".**
> We implement an OSS-equivalent service in a non-`ee` path and unlock the feature flag.

Done already (this round): **`Feature.AI` granted for self-hosted** (`license-check.service.ts`
`SELF_HOSTED_OSS_FEATURES = [API_KEYS, MCP, AI]`) → AI settings now show by default. Companion
unlock spec: [`docmost-ai-features-design.md`](./docmost-ai-features-design.md) §6.

---

## 1. Audit — requested features

| # | Feature | Flag | Tables/deps present | OSS server today | Gap | Effort |
|---|---------|------|---------------------|------------------|-----|--------|
| 1 | **AI Chat (Assistant)** | `ai` | `ai_chats`,`ai_chat_messages` ✅; full client `ee/ai-chat/**` | none (8 `/ai/chats/*` 404) | whole chat backend + tool loop | **L** |
| 2 | **DOCX import** | `import:docx` | `mammoth` dep ✅; `processHTML` ✅ | `processDocx` → `require ee` throws | OSS docx→html→prosemirror | **S–M** |
| 2b| **PDF import** | `import:pdf` | none (needs pdf-text dep) | `processPdf` → `require ee` throws | add pdf dep + OSS extract | **M** |
| 3 | **Full-text search in attachments** | `attachment:indexing` | `attachments-search` migration ✅; processor wired | `require ee/AttachmentEeService` | OSS extract + index (tsv) | **M** |
| 4 | **Page-level permissions** | `page:permissions` | `page_permissions` ✅ + `PagePermissionRepo` ✅; client ee | EE-locked | OSS service/controller + CASL | **L** |
| 5 | **Page verification & approval** | `page:verification` | `page_verifications` migration ✅ | no module | OSS repo + service/controller | **M** |
| 6 | **Resolve comments** | `comment:resolution` | `comments.resolved_at/resolved_by_id` ✅; comment module ✅ | no resolve route | resolve/unresolve endpoint + gate | **S** |
| 7 | **Templates** | `templates` | `templates` ✅ + `TemplateRepo` ✅; client | no module | OSS template service/controller | **M** |
| 8 | **Audit logs** | `audit:logs` | `audit` table ✅ + middleware/interceptor ✅ | `AuditService.log` is a **no-op stub** | OSS recording + list endpoint | **M** |

(S = small, M = medium, L = large.)

## 2. OSS approach per feature

### 6. Resolve comments (S) — *first slice*
- Add `POST /api/comments/resolve { commentId, resolved }` to the existing
  [comment.controller.ts](../../apps/server/src/core/comment/comment.controller.ts).
- `CommentService.resolveComment(commentId, userId, resolved)` sets `resolvedById`/`resolvedAt`
  (columns exist) after CASL edit/comment check on the page's space.
- Gate behind `Feature.COMMENT_RESOLUTION` (add to `SELF_HOSTED_OSS_FEATURES`). Surface
  `resolvedAt/resolvedById` in comment reads so the client chips render.

### 8. Audit logs (M)
- Replace the no-op `AuditService.log` with an OSS implementation that inserts into the `audit`
  table (async, fire-and-forget so it never blocks requests). Add `AuditRepo`.
- `POST /api/audit/logs` (paginated, workspace-scoped, admin-only) for the client log viewer.
- Unlock `Feature.AUDIT_LOGS`.

### 2/2b. DOCX & PDF import (S–M / M)
- **DOCX:** implement OSS `processDocx` using `mammoth` (already a dep): `convertToHtml(buffer)`
  → reuse the existing `processHTML` path. Drop the EE `require`.
- **PDF:** add a pure-JS text dep (e.g. `unpdf`/`pdf-parse`), extract text → wrap as HTML →
  `processHTML`. (Lower fidelity than EE's layout-aware import; documented as such.)
- Unlock `Feature.DOCX_IMPORT` / `Feature.PDF_IMPORT`.

### 3. Full-text search in attachments (M)
- OSS `AttachmentIndexService.indexAttachment(id)` / `indexAttachments(workspaceId)`: extract text
  (mammoth for docx, pdf dep for pdf, plain for txt/md) → store into the `attachments-search`
  tsv/column → include in the existing search query. Wire into the already-present
  `attachment.processor` (replace the EE `require`).
- Unlock `Feature.ATTACHMENT_INDEXING`.

### 7. Templates (M)
- OSS `TemplateModule` (service + controller) over the existing `templates` table + `TemplateRepo`:
  list/create/update/delete templates; "create page from template". Match the client
  `apps/client/src/**/template*` calls. Unlock `Feature.TEMPLATES`.

### 5. Page verification & approval (M)
- OSS `PageVerificationModule` over `page_verifications`: request/approve/revoke verification,
  list status; notification helper already exists
  ([verification.notification.ts](../../apps/server/src/core/notification/services/verification.notification.ts)).
  Unlock `Feature.PAGE_VERIFICATION`.

### 4. Page-level permissions (L)
- OSS `PagePermissionModule` over `page_permissions` + `PagePermissionRepo`: grant/list/revoke
  per-page user/group permissions, and **integrate into the CASL page-ability factory** so reads/
  writes honor page-level grants (the invasive part). Unlock `Feature.PAGE_PERMISSIONS`.

### 1. AI Chat / Assistant (L)
- New `/api/ai/chats/*` over `ai_chats`/`ai_chat_messages` matching the client contract
  ([ai-chat.types.ts](../../apps/client/src/ee/ai-chat/types/ai-chat.types.ts)): `create`, list,
  `info`, `delete`, `update`, `search`, `upload`, and `send` (SSE).
- `send` runs a tool-calling loop with `streamText({ tools })` over `chatModel()`; tools reuse the
  existing wiki operations (search_pages/get_page/…) and RAG context (`AiAnswerService`) from
  `mentionedPageIds`/`contextPageId`. SSE events per the contract: `chat_created`, `content`,
  `tool_call`, `tool_result`, `done`, `error`. Phases: B3.1 chat CRUD → B3.2 plain streamed
  send → B3.3 tool-calling → B3.4 attachment upload.

## 3. Recommended execution order (value × readiness)

1. **Resolve comments** (S, ready) — *implemented this round.*
2. **DOCX import** (S–M, `mammoth` present)
3. **Audit logs** (M, recording + list)
4. **Templates** (M)
5. **Attachment full-text** (M) + **PDF import** (M) — share the text-extraction layer
6. **Page verification** (M)
7. **Page permissions** (L, CASL-invasive)
8. **AI Chat** (L, tool loop) — biggest; do last or in parallel as its own workstream

Each lands as its own slice: OSS module + unlock the flag + unit tests + build/lint, committed
categorized (code → test → docs), matching the AI/MCP/API-key precedent.

## 4. Cross-cutting notes
- **Entitlement unlock:** each completed feature appends its `Feature.*` to
  `SELF_HOSTED_OSS_FEATURES` in `license-check.service.ts` (single source of truth for both the
  entitlements endpoint and the enable-gate) — only once its OSS backend is real, to avoid
  exposing broken toggles (the rule applied to AI Search / B2).
- **No EE code copied.** OSS services live outside `apps/server/src/ee`; where core does
  `require('../ee/...')`, we add an OSS service it resolves to (or replace the throw path).
- **Verification:** server build + unit tests + lint per slice; live/E2E (real files, search,
  CASL) noted where it needs a running stack.
