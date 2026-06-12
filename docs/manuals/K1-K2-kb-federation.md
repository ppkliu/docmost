# K1/K2 — External Knowledge Bases (Cognee / LLM-Wiki / Custom) — Usage & Testing Manual

> Status: **implemented (OSS)**, extended by **K3/K4 v1** (Cognee sync + permission scoping —
> see [docmost-kb-federation-design.md](../design/docmost-kb-federation-design.md) §6).
> Admins connect external knowledge bases under *Settings → AI*; AI Chat gains one federated
> search tool per enabled connector. Cognee connectors can additionally **sync** wiki content
> into per-space datasets (rebuild-per-space, debounced 5 min); synced searches are scoped to
> the spaces the caller belongs to, and E7-restricted pages never leave the wiki (they are
> also excluded from the internal pgvector store). K3 live verification pending a real Cognee
> deployment.

## 1. What it does
- Connectors live in `workspaces.settings.ai.knowledgeBases[]`
  (`{ id, type, name, baseUrl, apiKey?, searchPath?, enabled }`). API keys are encrypted at
  rest (same `enc:v1:` AES-GCM as the AI provider key), never returned to clients
  (`hasApiKey` only), and stripped from every workspace-serializing endpoint.
- AI Chat (`AiChatService.buildTools`) registers `search_<sanitized name>` per **enabled**
  connector next to `search_workspace`. Results carry `source: <connector name>`; an
  unreachable KB returns `{ error, results: [] }` so the chat turn continues.
- Per-type search adapters: cognee `POST {base}/api/v1/search` (`searchType: CHUNKS`),
  llm-wiki `POST {base}/api/search`, custom `POST {base}{searchPath || /search}` — all accept
  `{results|items|data: [...]}` or bare arrays, objects or strings.
- **Scope**: synced cognee connectors are permission-scoped (per-space datasets, caller's
  memberships, K4.1). **Non-synced** connectors remain workspace-global — connect only KBs
  whose content is workspace-public.

## 2. Usage

### Frontend (*Settings → AI* → External knowledge bases card)
**Add knowledge base** → type (Cognee / LLM-Wiki / Custom), name, base URL, API key
(optional; blank keeps the stored key when editing), custom search path for Custom →
**Test connection** (works for drafts and stored connectors) → **Save**. Each row has an
enable switch, Edit, Delete.

### REST API (admin only, CASL `Manage` `Settings`)
| Endpoint | Body | Notes |
|---|---|---|
| `GET /api/ai/kb` | — | `{ connectors: [{ …, hasApiKey }] }` — keys never returned |
| `POST /api/ai/kb` | `{ id?, type, name, baseUrl, apiKey?, clearApiKey?, searchPath?, enabled? }` | id omitted = create (`kb_<nanoid>`); blank apiKey keeps stored; baseUrl normalized |
| `POST /api/ai/kb/delete` | `{ id }` | |
| `POST /api/ai/kb/test` | `{ id }` or draft `{ type, baseUrl, apiKey?, searchPath? }` | runs a 1-result search; maps 401/404/timeout/unreachable to admin-friendly messages |

## 3. Automated tests
```bash
pnpm -C apps/server exec jest src/integrations/ai src/core/workspace --maxWorkers=1
```
`ai-kb.service.spec.ts` (10): encrypted create + generated id, update keeps/clears stored key,
unknown-id rejection, decrypt vs mask, per-type adapter URLs + bearer auth, tolerant result
parsing, test success/auth/unreachable mapping. `ai-chat.service.spec.ts` +1: federated tool
registration (enabled only), attributed results, graceful failure payload.
`workspace.service.spec.ts` +1: KB apiKey stripped from workspace responses.
Suites: ai+workspace = **87 tests green**; server+client `tsc` and eslint clean.

## 4. Live verification (2026-06-12, dev stack @3011 + mock KB on the docker host)
- Create custom connector → masked list; `psql` shows `enc:v1:` apiKey.
- `kb/test` with stored key → "Connected (1 result for test query)" (decrypt + reach + auth);
  wrong draft key → "Authentication failed — check the API key".
- `/users/me` contains the connector **without** `apiKey`.
- **End-to-end federation**: AI Chat send → the live model (qwen3.6-27b-fp8 via vLLM) emitted
  `tool_call search_mock_kb {query: "docmost federation"}` and the stream returned the
  attributed `tool_result` from the mock KB.
- Note: from inside the dev container the docker host is the bridge gateway (e.g.
  `172.21.0.1`), not `host.docker.internal` (no extra_hosts in dev compose).

## 5. Notes / limits
- K2 tool names are sanitized connector names (`search_team_cognee`); rename-safe but
  duplicates collapse to the first.
- Cognee adapter targets the v1 REST shape; verify against your deployed Cognee version
  (adapter isolated in `AiKbService.search`).
- i18n strings English-only (consistent with the AI cards).
