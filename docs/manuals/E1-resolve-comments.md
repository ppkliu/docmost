# E1 — Resolve Comments — Usage & Testing Manual

Feature unlocked from EE for self-hosted OSS. Lets users mark a comment thread as **resolved**
(and re-open it), with the resolver + timestamp recorded.

## 1. What it does
- A comment can be flagged `resolved` (stamps `resolved_by_id` + `resolved_at`) or un-resolved
  (clears both). Resolution is broadcast over the websocket so other viewers update live.
- Gated by the `comment:resolution` feature, now granted for self-hosted OSS
  (`SELF_HOSTED_OSS_FEATURES` in `license-check.service.ts`), so the resolve control appears in the
  comment UI.

## 2. Usage

### Frontend
Open a page with comments → on a comment thread, use the **Resolve** action (checkmark) in the
comment menu. Resolved threads render as resolved; toggling again re-opens them.

### REST API
`POST /api/comments/resolve` (JWT or API key)
```bash
curl -X POST "$BASE/api/comments/resolve" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "commentId": "<uuid>", "resolved": true }'
```
| field | type | notes |
|---|---|---|
| `commentId` | uuid (required) | the comment to resolve/unresolve |
| `resolved` | boolean (required) | `true` to resolve, `false` to re-open |

Returns the updated comment including `resolvedById` and `resolvedAt`. Caller needs **comment**
permission on the page's space (same CASL check as editing a comment).

## 3. Automated tests
- `apps/server/src/core/comment/comment.resolve.spec.ts` (2 tests):
  - resolving stamps `resolvedById` + `resolvedAt` (a `Date`) and emits the `commentUpdated` ws event
  - unresolving clears both fields
- Entitlement: `license-check.service.spec.ts` asserts `comment:resolution` is granted.

Run:
```bash
cd apps/server
pnpm exec jest src/core/comment/comment.resolve.spec.ts
pnpm exec jest src/integrations/environment/license-check.service.spec.ts
pnpm run build      # type-check
pnpm exec eslint "src/core/comment/**/*.ts"
```
Status at implementation: build ✅ · resolve 2/2 ✅ · entitlement 4/4 ✅ · lint ✅.

## 4. Manual / human testing (needs a running stack)
Prereq: `docker compose up -d` (Postgres + Redis), server + client running, migrations applied.

1. **UI round-trip**
   - Open a page, add a comment, then click **Resolve** on it.
   - Expect: the thread shows as resolved; reload the page → still resolved.
   - Click **Re-open** → thread returns to open; reload → still open.
2. **Live update (websocket)**
   - Open the same page in two browser sessions. Resolve a comment in one.
   - Expect: the other session reflects the resolved state without a manual refresh.
3. **API**
   - `POST /api/comments/resolve {commentId, resolved:true}` → 200, body has `resolvedById` =
     your user id and a non-null `resolvedAt`.
   - Call again with `resolved:false` → `resolvedById`/`resolvedAt` are null.
4. **Permission**
   - As a user with only **read** (not comment) access to the space, call resolve → expect 403.
5. **Entitlement**
   - In *Settings*, confirm comment resolution is available (feature granted); resolved chips show
     in the comment UI.

## 5. Notes / limits
- The endpoint records who/when; it does not delete or hide resolved comments (the client decides
  how to display them).
- No new tables/migrations — uses the existing `comments.resolved_at` / `resolved_by_id` columns.
