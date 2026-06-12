# Hermes 知識沉澱治理 — H1 歸屬映射 & H2 審核佇列 — Design

> Status: **H1 implemented**, **H2 phase 0 available by convention / phase 1 designed**.
> Context: 目标3 — Hermes submits user knowledge into the wiki via API key + REST/MCP
> (contract shipped in workstream D: skills bundle, organize pipeline, dedup, bulk import).
> This doc covers governance: who authored it (H1) and who approves it (H2).
> Tasks tracked in [docmost-oss-tasks.md](./docmost-oss-tasks.md) §11.

## H1 — Attribution mapping (implemented)

### Problem
A docmost API key belongs to one user. A single Hermes service key attributes every
auto-submitted page/comment to that service account, losing the real author.

### Options considered
1. **Per-user API keys** — works today with zero code (each Hermes user stores their own
   docmost key). Best fidelity, but key distribution at org scale is painful.
2. **`X-On-Behalf-Of` delegation on service keys** — one service key, per-request
   attribution. **Chosen** as the additive option; (1) remains fully supported.

### Implemented behavior (`jwt.strategy.ts`)
- On any **API-key-authenticated** request (OSS and EE key services alike), the
  `X-On-Behalf-Of: <email>` header swaps the request identity to that workspace user.
- Guardrails:
  - only honored when the **key owner is a workspace admin/owner** — member keys get 401
    `This API key cannot act on behalf of other users`;
  - unknown / deactivated target → 401 (fail loudly; never silently mis-attribute);
  - `req.raw.impersonatorId` = key owner id, surfaced for audit logging; every delegation is
    logged (`API key of <owner> acting on behalf of <target>`).
- Scope note: the swapped identity carries the **target user's** permissions (CASL evaluates
  the target), so delegation cannot escalate beyond what the real author could do — Hermes
  writing "as Alice" can only touch spaces Alice can write to.
- Hermes side: map its user → docmost email; send the header on create/update calls (REST and
  MCP share the same auth path, so both honor it).

### H1 follow-ups
- ⬜ audit event for delegated writes (uses `impersonatorId`; blocked on choosing an
  `AuditEvent` name upstream-compatibly)
- ⬜ optional per-key allowlist (`api_keys.delegationScope`) if admin-wide delegation proves
  too broad

## H2 — Review queue

### Phase 0 — label convention (available now, zero code)
Native labels (D1) + the organize pipeline already support a working review flow:
- agent submits pages, then calls `add_page_labels` with **`needs-review`**;
- reviewers filter by label (label pages list exists in the client), edit/approve, and remove
  the label; the agent recipe documents the convention (skills bundle: RECIPE.organize).
Limits: no hard gate (content is live immediately), no approve/reject action trail.

### Phase 1 — first-class review state (designed)
- `pages.reviewStatus: null | 'pending' | 'approved' | 'rejected'` (migration; null = normal
  page, the default for human-created content).
- Submission: API/MCP create-page gains `requestReview?: boolean` → `pending`. Pending pages:
  - visible and editable per normal permissions, but **excluded from AI indexing/sync**
    (embedding pipeline + K3 KB sync skip them — prevents unreviewed content from entering
    retrieval) and badged in the editor/tree;
  - listed in a reviewer queue: `POST /pages/review-queue` (space-scoped, paginated).
- Actions (space admins / writers with E7-manage on the page):
  `POST /pages/review { pageId, action: approve|reject, note? }` →
  `approved` (clears the badge, triggers indexing) | `rejected` (moves to trash, note posted
  as a comment). Both audit-logged; both emit the existing notification machinery.
- E6 (page verification) remains a separate, later concern: verification is "this content is
  still correct", review is "this content may enter the wiki".

### Phase 1 task breakdown
- ⬜ H2.1 migration + repo fields + `requestReview` on create paths (REST/MCP)
- ⬜ H2.2 indexing/sync exclusion for `pending` (embedding processor + K3 hook)
- ⬜ H2.3 queue + review endpoints + audit events
- ⬜ H2.4 client: queue page under the space, editor badge, approve/reject UI
- ⬜ H2.5 skills bundle: replace the label convention with `requestReview` in the recipes

> Pending-work status (incl. the H1 follow-ups) is consolidated in
> [docmost-oss-tasks.md §12](./docmost-oss-tasks.md).

## Verification
- H1 unit (5, green): pass-through without header; admin/owner swap + impersonatorId; member
  key rejected; unknown/disabled target rejected.
- H1 live checklist: admin API key + `X-On-Behalf-Of` on `/users/me` returns the target
  identity; wrong email → 401; member-owned key + header → 401.
- H2 phase 1: per-task (queue listing respects space CASL; pending pages absent from AI
  answers; approve re-indexes; reject trashes + comments).
