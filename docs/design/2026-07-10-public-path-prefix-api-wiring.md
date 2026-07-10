# Public Path Prefix — Client API Wiring

Status: fixed (core), follow-ups pending
Date: 2026-07-10

## Background

When Docmost is deployed under a sub-path (`DOCMOST_PUBLIC_PATH_PREFIX=/wiki`), the
front reverse proxy only forwards `/wiki/*` to the Docmost stack (Caddy → server).
Any request that reaches the front proxy **without** the `/wiki` prefix stays in the
outer namespace (e.g. WUJI's `/api`) and never reaches Docmost — the browser sees a
`405`/HTML response with no `Via: Caddy` header.

The prefix subsystem already existed on the client:

- `getPublicPathPrefix()` reads `window.CONFIG.DOCMOST_PUBLIC_PATH_PREFIX` (injected at
  runtime by the server's `StaticModule` from `process.env.DOCMOST_PUBLIC_PATH_PREFIX`).
- `getBackendUrl()` = `origin + prefix + "/api"`.
- `withPublicPath(path)` prepends the prefix to a path (no-op when prefix is empty).

…but the shared axios client never used them.

## Root cause

`apps/client/src/lib/api-client.ts` hard-coded `baseURL: "/api"`. Every REST call goes
through this single axios instance, so **all** API traffic ignored the prefix and hit the
bare `/api/...` path → outer proxy `405`.

## Fix (done)

Single central change — covers all ~179 REST endpoints that flow through the shared client:

- `baseURL: "/api"` → `baseURL: getBackendUrl()`
- Response-interceptor path comparisons made prefix-aware so they still match under `/wiki`:
  - `exemptEndpoints` (`/api/pages/export`, `/api/spaces/export`) → wrapped in `withPublicPath(...)`
  - collab-token 401 exemption `=== "/api/auth/collab-token"` → `=== withPublicPath("/api/auth/collab-token")`

When the prefix is empty these all resolve back to the original bare paths, so the change
is backward-compatible with root-path deployments.

Verify (server, after client rebuild + hard refresh):
`curl -sI -X POST $BASE/wiki/api/users/me` → `401` + `Via: 1.1 Caddy` (reached Docmost);
bare `$BASE/api/users/me` → `405` (blocked by front proxy).

## Follow-ups NOT covered by the central fix

These bypass the shared axios client and still hard-code bare `/api`. They only matter for
the corresponding EE features (AI / PDF export). `fetch()` has no `baseURL`, so each call
must be wrapped individually, e.g. `fetch(withPublicPath("/api/ai/chats/send"), …)`.
Reference the EE implementation when building the in-house version, then apply the same wrap.

| File | Line | Bare path | Feature |
|---|---|---|---|
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts` | 76 | `/api/ai/chats/send` | AI chat send |
| `apps/client/src/ee/pdf-export/pdf-render-page.tsx` | 27 | `/api/pdf-export/render` | PDF export |
| `apps/client/src/ee/ai/services/ai-search-service.ts` | 22 | `/api/ai/answers` | AI search |
| `apps/client/src/ee/ai/services/ai-service.ts` | 24 | `/api/ai/generate/stream` | AI generate (stream) |

### To double-check (likely fine)

These build `/api/files/...` URL strings but are normally re-prefixed by `getFileUrl()` at
render time. Confirm they are not consumed raw (e.g. a direct download link) before trusting them:

| File | Line |
|---|---|
| `apps/client/src/features/editor/components/common/editor-paste-handler.tsx` | 204 |
| `apps/client/src/features/search/components/search-result-item.tsx` | 42 |

Also note `apps/client/src/ee/utils.ts:15` builds an `/api/auth/exchange` URL against a
different hostname (`getHostnameUrl`) — a cross-domain concern, not the same sub-path issue.
