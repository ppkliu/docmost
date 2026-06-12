# E7 — Page-Level Permissions (OSS) — Usage & Testing Manual

> Status: **implemented (OSS)**. Restrict individual pages so only selected users/groups can
> view or edit them, overriding space-level access. Enforcement (`PageAccessService` +
> `PagePermissionRepo` over `page_access`/`page_permissions`) and the client share modal were
> already in the codebase; this slice adds the missing **management API** (7 endpoints matching
> the client contract) and unlocks `page:permissions` for self-hosted.

## 1. What it does
- A page can be **restricted**: a `page_access` row plus `page_permissions` entries
  (user/group → `reader`|`writer`). Descendant pages inherit the restriction; access checks
  walk the ancestor chain (already enforced across pages, search, export, notifications, MCP).
- The acting user is seeded as the first **writer** on restrict, and a restricted page must
  always keep ≥1 writer (removal/demotion of the last writer is rejected) — no lockouts.
- **Manage rules**: space admins always manage (recovery path, even when excluded from the
  page); otherwise restricted pages are managed by writers on the nearest restriction and
  unrestricted pages by anyone with space-level page-manage rights (admin/writer).
- Permission checks are cached 5s (`PERMISSION_CACHE_TTL_MS`) — revocations apply within ~5s.

## 2. REST API (JWT auth, paths match `apps/client/src/ee/page-permission/services`)
| Endpoint | Body | Notes |
|---|---|---|
| `POST /api/pages/restrict` | `{ pageId }` | idempotent; seeds caller as writer |
| `POST /api/pages/remove-restriction` | `{ pageId }` | deletes the restriction + its entries |
| `POST /api/pages/add-permission` | `{ pageId, role, userIds?, groupIds? }` | role `reader\|writer`; re-adding an existing member updates its role; ids must belong to the workspace (400 otherwise) |
| `POST /api/pages/remove-permission` | `{ pageId, userIds?, groupIds? }` | rejects removing the last writer |
| `POST /api/pages/update-permission` | `{ pageId, role, userId?\|groupId? }` | rejects demoting the last writer |
| `POST /api/pages/permissions` | `{ pageId, cursor? }` | paginated members (groups first); empty for unrestricted pages |
| `POST /api/pages/permission-info` | `{ pageId }` | `{ restrictionId?, hasDirectRestriction, hasInheritedRestriction, inheritedFrom?, userAccess: { canView, canEdit, canManage } }` |

## 3. Automated tests
```bash
pnpm -C apps/server exec jest src/core/page/page-access src/integrations/environment --maxWorkers=1
```
`page-permission.service.spec.ts` (14): manage-rights resolution (unrestricted via space role,
restricted via page writer, admin lockout recovery), inherited-ancestor banner lookup, space
non-member rejection, restrict seeding + idempotency, add upsert + workspace validation,
last-writer guards (remove + demote), not-restricted 400, empty list for unrestricted.
License unlock covered in `license-check.service.spec.ts` (now includes `page:permissions`).
All green; server `tsc --noEmit` + eslint clean.
*(Also repaired the pre-existing auto-generated `environment.service.spec.ts` stub, which
failed DI and never passed.)*

## 4. Live verification (2026-06-12, dev stack @3011)
- `/workspace/entitlements` now lists `page:permissions` → the client share modal's
  permission tab is enabled.
- Full endpoint pass: create page → `permission-info` (open, canManage) → `restrict` →
  `permission-info` (restrictionId, direct) → `permissions` (creator listed as writer) →
  demote last writer → **400 "must keep at least one writer"** → child page reports
  `hasInheritedRestriction` with `inheritedFrom` = parent (id/slugId/title) → group
  add-permission/remove-permission round-trip ("Everyone" as reader) → unknown group id →
  **400 "Group not in workspace"** → `remove-restriction` → open again.

## 5. Manual / human testing (UI)
1. Open a page → Share → the **Permissions** tab is enabled (no EE license).
2. Switch General access to **Restricted** → you appear as Writer.
3. Add a user/group as Reader → log in as that user → page is read-only; a non-listed space
   member gets 404/forbidden on the page and it drops out of search results.
4. Sub-pages show the "Inherited restriction" banner linking to the restricted ancestor.
5. Try removing yourself as the only writer → blocked with an error toast.
6. Remove the restriction → space-level access applies again.

## 6. Notes / limits
- Space admins can always manage restrictions (by design, for recovery) but do **not** gain
  content access — `canView` stays false for them if not listed.
- No audit events for restrict/permission changes yet (no matching `AuditEvent` values
  upstream); follow-up if needed.
- Share-modal i18n strings follow the upstream client (English fallback).
