# Docmost OSS MCP Server — 規格書 (Workstream C)

> Status: **DESIGN / for review**. No code yet. Open-source, in-server implementation of
> Docmost's **MCP (Model Context Protocol)** server so MCP-aware clients (Claude Desktop,
> Claude Code, Cursor, opencode, Hermes) can drive the wiki — matching the official
> behavior at <https://docmost.com/docs/user-guide/mcp>.
>
> Companion specs: [`docmost-agent-api-spec.md`](./docmost-agent-api-spec.md) (REST gateway),
> [`docmost-ai-features-design.md`](./docmost-ai-features-design.md) (AI features).

---

## 1. Official behavior to match

- **Enable:** workspace admin toggles MCP in *Settings > AI & MCP* (`mcpEnabled` /
  `settings.ai.mcp`).
- **Endpoint:** `https://<docmost>/mcp` (note: **excluded from the `/api` global prefix** —
  already wired at `apps/server/src/main.ts:42` `exclude: [..., 'mcp']`).
- **Auth:** personal **API key** as `Authorization: Bearer <key>` (same keys as the REST API).
- **Permissions:** identical to the web app — a request only sees spaces/pages the key's owner
  can access; writes require the owner's edit rights (reuse CASL).
- **Tools (official set):**
  - **Pages:** search, get content, create, update, list recent, list child pages, duplicate,
    copy between spaces, move within/across spaces.
  - **Spaces:** get details, list, create, update (name/description).
  - **Comments:** list for a page, add, update.
  - **Other:** search attachments, list workspace members, get current user.

## 2. Current OSS state (verified)

Only the *surface* exists; the server implementation is EE-locked and absent:
- Feature flag `Feature.MCP = 'mcp'` — `apps/server/src/common/features.ts`.
- Workspace setting `mcpEnabled` — `apps/server/src/core/workspace/dto/update-workspace.dto.ts:42`.
- Route exclusion for `/mcp` — `apps/server/src/main.ts:42`.
- SDK dependency `@modelcontextprotocol/sdk` is already in `apps/server/package.json`.
- `apps/server/src/ee/` is **empty** → no MCP handler, no API-key validator.

## 3. Shared keystone — OSS API-key module (REQUIRED first)

MCP auth and the official REST API auth are the **same** mechanism. The plumbing is in OSS
core but the validator is EE:
- `api_keys` table migration ships in OSS:
  `apps/server/src/database/migrations/20250912T101500-api-keys.ts`.
- `TokenService.generateApiToken(...)` and `JwtType.API_KEY` exist in core.
- `jwt.strategy.ts:77-101` `require()`s `./../../../ee/api-key/api-key.service` and throws
  *"Enterprise API Key module missing"* when absent.

**OSS-equivalent to build (do not copy EE):**
- `ApiKeyRepo` (Kysely) over the existing `api_keys` table.
- `ApiKeyService`:
  - `create(user, {name, expiresAt?})` → generate random secret, **store only a hash**
    (e.g. sha256), return the plaintext **once**; mint the API-key JWT via
    `TokenService.generateApiToken`.
  - `validateApiKey(payload)` → load key by `apiKeyId`, check workspace, not-revoked,
    not-expired; update `last_used_at`; return `{ user, workspace }` (the exact shape the
    strategy returns for ACCESS tokens).
  - `list(user|workspace)`, `revoke(id)` (soft delete).
- `ApiKeyController` (`/api/api-keys`): `create`, `list`, `delete` — matching the client
  `apps/client/src/ee/api-key/**` so the existing settings UI works.
- Wire `ApiKeyModule` into `app.module` and make `jwt.strategy.validateApiKey` resolve the OSS
  service (keep the EE `require()` as a fallback so an EE build still works).

This single module unlocks **both** the official REST API auth *and* MCP auth.

## 4. MCP server design

### 4.1 Transport & mount
- Use `@modelcontextprotocol/sdk` with the **Streamable HTTP** transport, mounted at `/mcp`
  (Fastify route registered outside the `/api` prefix — the exclusion already exists).
- Stateless per-request auth: read `Authorization: Bearer <api-key>`, validate via
  `ApiKeyService.validateApiKey`, and run the tool call **as that user** (build a CASL ability
  per request). Reject with MCP error if MCP is disabled for the workspace
  (`settings.ai.mcp !== true`) or the key is invalid.

### 4.2 Tool layer = thin adapters over existing services
Each MCP tool maps to an **existing core service/controller path** (no new business logic):

| MCP tool | Backing service / route |
|---|---|
| `search_pages` | `SearchService` / `POST /api/search` |
| `get_page` | `PageRepo.findById` (incl. content) / `POST /api/pages/info` |
| `create_page` | `PageService.create` / `POST /api/pages/create` |
| `update_page` | `PageService.update` (Yjs path) / `POST /api/pages/update` |
| `list_recent_pages` | `POST /api/pages/recent` |
| `list_child_pages` | `PageService.getSidebarPages` / `POST /api/pages/sidebar-pages` |
| `duplicate_page` | `POST /api/pages/duplicate` |
| `move_page` | `POST /api/pages/move` (+ `move-to-space`) |
| `get_space` / `list_spaces` / `create_space` / `update_space` | `SpaceModule` controllers |
| `list_comments` / `add_comment` / `update_comment` | `CommentModule` controllers |
| `search_attachments` | attachment search service |
| `list_members` | `WorkspaceModule` members |
| `get_current_user` | resolved from the validated API key |

> Implementation note: invoke the **services** directly (in-process) rather than HTTP self-
> calls, passing the resolved user + a per-request CASL ability — this is exactly how the EE
> MCP and the AI features call internal services. Verify each space/comment route name at
> implementation time (modules confirmed present in `core.module.ts`).

### 4.3 Module placement
- New `apps/server/src/mcp/mcp.module.ts` + `mcp.controller.ts` (or a Fastify plugin
  registered in `main.ts`), imported by `app.module` — **not** under `ee/`.
- Reuses `ApiKeyService`, `PageService`, `SearchService`, `SpaceService`, `CommentService`,
  `AttachmentService`, CASL ability factories.

## 5. Client configuration (docs to ship)
- **Claude Code:** `claude mcp add docmost --transport http <url>/mcp --header "Authorization: Bearer <key>"`.
- **Claude Desktop / Cursor:** `mcp-remote` via npx pointing at `<url>/mcp` with the bearer
  header. Provide a ready-to-paste JSON snippet in the README.

## 6. Feature-gate note
Same wrinkle as the AI features: the client only surfaces MCP settings when
`useHasFeature(Feature.MCP)` (entitlements). The OSS build must grant `Feature.MCP` (and
`Feature.AI`) for self-hosted — see the entitlement spike in
[`docmost-ai-features-design.md`](./docmost-ai-features-design.md) §6; apply the same fix for
`'mcp'`.

## 7. Phasing
- **C0 — API-key keystone** (§3): required by both MCP and the official REST API. Build first.
- **C1 — MCP read tools:** `search_pages`, `get_page`, `list_*`, `get_current_user`,
  `list_spaces/get_space`, `list_comments`, `search_attachments`, `list_members`.
- **C2 — MCP write tools:** `create_page`, `update_page` (Yjs), `move/duplicate`,
  `create/update_space`, `add/update_comment`.
- **C3 — client docs + entitlement unlock.**

## 8. Test strategy
- **API-key unit tests:** create→hash stored (plaintext not persisted)→`validateApiKey`
  returns `{user,workspace}`→expired/revoked rejected→`last_used_at` updated.
- **jwt.strategy:** API_KEY JWT resolves via OSS service; ACCESS path unchanged.
- **MCP integration:** with `@modelcontextprotocol/sdk` client over HTTP + a real bearer key:
  `list_spaces` then `create_page` then `get_page` (assert round-trip); a reader key cannot
  write / cannot see other spaces (CASL enforced); MCP-disabled workspace → tool calls
  rejected.
- **Live client smoke:** add the server in Claude Code and call a tool.
- **Regression:** `app.module` boots with `ee` absent; `/mcp` returns proper MCP errors when
  unauthenticated.

## 9. Source references (verified)
- `apps/server/src/main.ts:42` (mcp prefix exclusion); `apps/server/src/common/features.ts`
  (`Feature.MCP`); `apps/server/src/core/workspace/dto/update-workspace.dto.ts:42`
  (`mcpEnabled`); `apps/server/src/core/auth/strategies/jwt.strategy.ts:77-101` (API-key
  delegation); `apps/server/src/database/migrations/20250912T101500-api-keys.ts` (table);
  `apps/server/src/core/auth/services/token.service.ts` (`generateApiToken`);
  `apps/server/src/core/core.module.ts` (Page/Search/Space/Comment/Attachment modules present);
  `@modelcontextprotocol/sdk` in `apps/server/package.json`.
