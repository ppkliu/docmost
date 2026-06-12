# KB Federation — K3 Sync Pipeline & K4 Scope Model — Design

> Status: **implemented (v1)** — see §6 for what shipped and how it deviates from the
> original §3 sketch (rebuild-per-space replaced the four-job incremental pipeline).
> Builds on K1 (KB connectors in `settings.ai.knowledgeBases`, encrypted keys, test endpoint)
> and K2 (per-connector `search_*` tools in AI Chat). Tasks tracked in
> [docmost-oss-tasks.md](./docmost-oss-tasks.md) §11.

## 1. Problem

K1/K2 give *query-side* federation: AI Chat can search external KBs (Cognee / LLM-Wiki /
custom). Two gaps remain for 目标2:

- **K3** — docmost content does not flow *into* Cognee, so its graph/memory features only see
  what other systems pushed there.
- **K4** — federated results must respect docmost permissions (space membership + E7 page
  restrictions). Today an enabled connector is visible to **every** chat user; that is safe
  only because external KBs contain external content. The moment docmost syncs its own pages
  out (K3), an unscoped search would leak restricted content back to unauthorized users.

K4 therefore gates K3: do not ship sync without the scope model.

## 2. K4 — Scope model

### 2.1 Decision: dataset-per-space, restricted pages excluded

| Option | Granularity | Cognee-side needs | Verdict |
|---|---|---|---|
| A. one dataset per workspace | none | nothing | leaks across spaces — rejected |
| B. **one dataset per space** | space | dataset filtering on search (native) | **chosen** |
| C. per-chunk ACL metadata + query-time filter | page | metadata filtering + custom query | most precise, most coupling; deferred |

- Cognee dataset id: `docmost_<workspaceId>_<spaceId>` (Cognee supports named datasets on
  `add` and dataset selection on `search`).
- **E7 interaction**: pages with a direct or inherited restriction (`page_access` chain) are
  **excluded from sync**. Space-level membership is the floor of option B; page-level
  restrictions are finer than the dataset, so restricted content must simply never leave
  docmost. On *restrict* → enqueue KB delete for the page + its restricted subtree
  (`getRestrictedSubtreeIds` exists); on *unrestrict* → re-enqueue ingest.
- **Metadata floor**: every ingested document carries
  `{ workspaceId, spaceId, pageId, slugId, title, updatedAt }` so option C remains a
  drop-in upgrade later.

### 2.2 Query-time scoping

- `search_<connector>` (K2) for a **synced** Cognee connector resolves the caller's space
  memberships (`SpaceMemberRepo.getUserSpaceIds`, used by AI Answers already) and passes the
  corresponding dataset ids to Cognee's search. No membership → tool returns empty.
- **External (non-synced) connectors** (LLM-Wiki, custom): content is not docmost-governed;
  enabling the connector makes it workspace-global by definition. This is an explicit,
  documented admin decision (the K1 card copy should say so). A per-connector
  `restrictToGroupId` is a possible later refinement.
- Audit note (separate from this design): verify the **pgvector embedding pipeline** also
  excludes restricted pages, and that `filterAccessiblePageIds` is applied on the AI Answers
  query path — same leak class, internal store.

## 3. K3 — Sync pipeline

### 3.1 Connector flag

`settings.ai.knowledgeBases[]` gains `sync?: boolean` (only meaningful for `type: cognee`).
Toggling it on triggers a backfill; off triggers a teardown. K1's upsert/strip/mask logic
already passes unknown fields through; only the DTO and card need the new field.

### 3.2 Jobs (reuse AI_QUEUE + AiQueueProcessor patterns)

| Job | Payload | Action |
|---|---|---|
| `KB_UPSERT_PAGE` | `{ connectorId, workspaceId, pageId }` | skip if restricted (2.1); else export page text (same extraction as embedding indexer) → Cognee `add` into the space dataset → `cognify` (batched/debounced) |
| `KB_DELETE_PAGE` | `{ connectorId, workspaceId, pageId }` | delete document from dataset |
| `KB_BACKFILL_SPACE` | `{ connectorId, workspaceId, spaceId }` | enumerate unrestricted pages → enqueue upserts (chunked) |
| `KB_TEARDOWN` | `{ connectorId, workspaceId }` | delete all `docmost_<ws>_*` datasets for the connector |

Emitters piggyback on the existing page-event hooks that feed embedding jobs (create/update/
move/delete already enqueue AI jobs; add a fan-out when any connector has `sync`). E7
restrict/unrestrict endpoints additionally enqueue delete/upsert for the affected subtree.

### 3.3 Failure & observability

- Per-job retry with exponential backoff (BullMQ defaults), `removeOnComplete`.
- Connector-level `lastSyncAt` / `lastError` written back into the connector record (masked
  responses already flow to the K1 card → show a sync badge).
- Rate limit: `cognify` is expensive — debounce per dataset (e.g. run at most once / 5 min per
  space, jobId-keyed like the existing `ai-search-disabled-<ws>` pattern).

### 3.4 Cognee API surface used

`POST /api/v1/add` (data + datasetName), `POST /api/v1/cognify` (datasets), `POST /api/v1/search`
(query + datasets + searchType), `DELETE /api/v1/datasets/{id}`. Exact paths verified against
the deployed Cognee version at implementation time (the K1 adapter already isolates per-type
URL shapes in one place: `AiKbService.search`).

## 4. Task breakdown

- ⬜ K4.1 space-scope resolution in the K2 tool for synced connectors (dataset ids from the
  caller's memberships; empty on none)
- ⬜ K4.2 restricted-page exclusion helper (`isPageSyncable(pageId)` over the E7 ancestor
  chain) + audit of the embedding pipeline for the same rule
- ⬜ K3.1 connector `sync` flag (DTO + card + masking passthrough)
- ⬜ K3.2 queue jobs + processor (upsert/delete/backfill/teardown) + page-event fan-out
- ⬜ K3.3 E7 hook: restrict/unrestrict → KB delete/re-ingest for the subtree
- ⬜ K3.4 sync status surfacing (lastSyncAt/lastError on the K1 card)

## 5. Verification plan

Unit: syncable-page rule (restriction chain), job emission fan-out, dataset id mapping,
scope resolution (memberships → datasets, none → empty). Live (dev stack + a real Cognee
container): enable sync → backfill lands pages in per-space datasets → chat search as a
member returns synced chunks; as a non-member of the space returns none; restrict a page →
it disappears from the dataset within one job cycle.

## 6. Implemented (v1) — deviations from §3

**Strategy change**: the four incremental jobs (UPSERT/DELETE/BACKFILL/TEARDOWN) collapsed
into **rebuild-per-space**: any page change schedules a debounced (5 min, stable
`jobId=kb-sync-<connector>-<space>`) `KB_SYNC_SPACE` job that deletes the space dataset,
re-adds every syncable page (batches of 20), and runs `cognify` once. Rationale: correct by
construction without depending on Cognee's per-document delete API surface; incremental
upserts remain a later optimization. `KB_TEARDOWN` is the only other job.

Shipped pieces:
- **K4.2** `AiIndexingService.embedPages` drops E7-restricted pages from the pgvector store
  (the audit confirmed AI Answers filtered by space only — a real leak class, now closed);
  `KbSyncService.syncSpace` applies the same `hasRestrictedAncestor` rule on export.
- **K3.3** E7 restrict/unrestrict enqueues `GENERATE_PAGE_EMBEDDINGS` for the affected
  subtree (computed *before* the restriction row is deleted on unrestrict); the processor
  fans that job out to both the embedding indexer and the KB sync scheduler.
- **K3.1** connector `sync` flag (cognee-only; DTO + card checkbox + grape "sync" badge).
- **K3.2** `KbSyncService` (schedulePageSync fan-out → debounced space jobs; backfill on
  sync-on = one job per space; teardown on sync-off; **inline** teardown on connector delete
  while credentials still exist) + `AiQueueProcessor` cases; cognee adapters in `AiKbService`
  (`addDocuments` `/api/v1/add`, `cognify`, `listDatasets`, `deleteDatasetByName`,
  dataset name `docmost_<ws>_<space>` with dashes stripped).
- **K4.1** synced cognee chat tools resolve the caller's space memberships per call and pass
  `datasets:[…]`; no memberships → empty result without an upstream call. External
  (non-synced) connectors stay workspace-global as designed.

Verification: 20 new unit tests (96 across ai + page-access suites) — rebuild flow excludes
restricted/empty pages, teardown deletes only `docmost_<ws>_*` datasets, fan-out per
space×connector, K4.1 dataset scoping + empty-membership short-circuit, K3.3 ordering.
Server/client tsc + eslint green. **Live verification still pending a real Cognee
deployment** (§5 checklist); hard-deleted pages don't resolve a spaceId, so their content
lingers until the next change in that space triggers a rebuild (soft-delete, the normal
path, is covered).

Open items (K3.4 status persistence, incremental upserts, Cognee live pass) are tracked in
[docmost-oss-tasks.md §12](./docmost-oss-tasks.md).
