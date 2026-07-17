# Docmost fork 改動盤點:`/wiki` 子路徑前綴 — rebase / merge 指南

狀態:進行中的常駐清單
最後更新:2026-07-16
適用分支:`main`(自建改動) vs `opensource`(upstream 鏡像)

## 這份文件是給誰看的

給**未來要把 upstream Docmost 最新版 merge / rebase 進本 fork** 的人(或 agent)。
它把「為了讓 Docmost 掛在 `/wiki` 子路徑而**不得不改動 Docmost 原始碼**」的所有位置集中列出,
說明**為什麼 upstream 沒這樣做**、**改了什麼**、以及**衝突時該怎麼取捨**。

配套文件:
- `docs/design/2026-07-10-public-path-prefix-api-wiring.md` — 每個功能面的前因後果、症狀與驗證(含 socket.io)。
- `wuji-adapter/deploy/DOCMOST_API_WEB_RESOURCES_AUDIT.md` — 部署面盤點:哪些公開路徑要帶 `/wiki`、反向代理怎麼設。
- `wuji-adapter/deploy/WIKI_PREFIX_ROUTING.md` — `/wiki` 單次剝除與 308 迴圈的深入說明。

## 核心設計原則(rebase 時務必守住)

> **公開 URL 加 `/wiki`,Caddy `handle_path` 恰好剝除一次,Docmost 內部路徑一律不改。**

推論:**後端**的 `/api` global prefix、socket.io 的 `/socket.io`、collab 的 `/collab` server path
**都維持 upstream 原樣**。所有前綴邏輯集中在**前端組 URL 時**與**server 靜態託管注入 window.CONFIG / 改寫 index.html 資產路徑時**。
upstream 之所以沒有這套,是因為官方 Docmost 預設部署在網域根路徑(`/`),沒有子路徑掛載需求。

因此 rebase 的判斷準則很簡單:**凡是 upstream 用「裸站內路徑字串」(`/api/...`、`/socket.io`、`/collab`、
`/login`、`window.location.pathname` 直接比對)組 URL 或做導向的地方,本 fork 都改成經過前綴 helper。**
merge 時若 upstream 在這些點新增/改寫程式,務必把新程式也套上同一組 helper。

## 前綴 helper 的單一真相來源

`apps/client/src/lib/config.ts`(**fork 新增函式,務必保留**):

| helper | 作用 | 前綴為空時 |
|---|---|---|
| `getPublicPathPrefix()` | 讀 `window.CONFIG.DOCMOST_PUBLIC_PATH_PREFIX`,正規化成 `/wiki` 或 `""` | 回 `""` |
| `getPublicBaseUrl()` | `origin + 前綴` | `origin` |
| `getBackendUrl()` | `origin + 前綴 + /api` | `origin + /api` |
| `withPublicPath(path)` | 幫站內路徑補前綴(已帶則不重複) | 原路徑不變 |
| `stripPublicPath(path)` | 從瀏覽器路徑去掉前綴,還原成 router path | 原路徑不變 |
| `getCollaborationUrl()` | collab WebSocket URL = `前綴 + /collab`(或 `COLLAB_URL`) | `origin + /collab` |
| `getSocketPath()` | socket.io 的 `path` = `前綴 + /socket.io`(2026-07-16 新增) | `/socket.io`(= 預設) |

**全部 helper 在前綴為空時都退化成 upstream 原行為**,所以這些改動對根路徑部署 100% 向後相容——
這也是 merge 時可以放心保留 fork 版本的依據。

## 檔案清單:改了什麼、為什麼、怎麼 merge

以下皆相對 `opensource` 分支。行號為 2026-07-16 當下,merge 後可能位移,以符號/字串為準。

### 前端 — 前綴機制核心

| 檔案 | 改動 | 為何 upstream 不同 | merge 策略 |
|---|---|---|---|
| `apps/client/src/lib/config.ts` | 新增上表所有 helper | upstream 無子路徑概念 | **保留 fork 版**;upstream 若改此檔多為新增其他 config,合併兩邊即可 |
| `apps/client/src/lib/api-client.ts` | `baseURL: "/api"` → `getBackendUrl()`;攔截器中 `exemptEndpoints`、collab-token 401 例外、`/share/` 比對、login/setup 導向全部改用 `withPublicPath()` / `stripPublicPath()` | upstream axios 寫死 `/api`、用裸路徑比對 | **高衝突風險**。upstream 常動攔截器。合併時:保 `baseURL: getBackendUrl()`,並把 upstream 新增的任何裸路徑字串比對套上 `withPublicPath()` |
| `apps/client/src/main.tsx` | `<BrowserRouter basename={getPublicPathPrefix() || undefined}>` | upstream 無 basename | 保留 fork 版 |
| `apps/client/src/lib/app-route.ts` | `getPostLoginRedirect()` / `getRedirectParam()` 對 redirect 值套 `stripPublicPath()` | 避免 `/wiki/wiki/...` 疊加 | 保留 fork 版 |

### 前端 — WebSocket(兩條都要帶前綴)

| 檔案 | 改動 | merge 策略 |
|---|---|---|
| `apps/client/src/features/user/user-provider.tsx` | `io(SOCKET_URL, { path: getSocketPath(), ... })`(2026-07-16 加 `path`) | **必查**:upstream 若重寫 socket 初始化,務必補回 `path: getSocketPath()`,否則 socket.io 打裸 `/socket.io/` 在 `/wiki` 部署會全數失敗 |
| `apps/client/src/features/editor/hooks/use-collaboration-url.ts` → `getCollaborationUrl()` | collab URL 走 `前綴 + /collab` | 保留;upstream 改 collab provider 時確認仍走此 helper |

### 前端 — 繞過共用 axios client 的 `fetch()`(EE 功能)

這些用原生 `fetch()`、不經 axios,所以各自要 `withPublicPath()`:

| 檔案 | 端點 |
|---|---|
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts:77` | `/api/ai/chats/send` |
| `apps/client/src/ee/ai/services/ai-search-service.ts:23` | `/api/ai/answers` |
| `apps/client/src/ee/ai/services/ai-service.ts:25` | `/api/ai/generate/stream` |
| `apps/client/src/ee/pdf-export/pdf-render-page.tsx:28` | `/api/pdf-export/render` |

merge 策略:upstream 若在 EE 新增 `fetch("/api/...")`,一律補 `withPublicPath()`(見防回歸 grep)。

### 前端 — 登入 / 登出 / SSO / 跨 hostname 導向

| 檔案 | 改動 |
|---|---|
| `apps/client/src/features/auth/hooks/use-auth.ts` | verify-email、logout(`window.location.replace`)導向套 `withPublicPath()` |
| `apps/client/src/ee/security/sso.utils.ts` | SAML/OIDC callback、login、entity ID 用 `getPublicBaseUrl()`;Google instance-wide 續用 canonical `APP_URL`(須含 `/wiki`) |
| `apps/client/src/ee/utils.ts` | `/api/auth/exchange` 套 `withPublicPath()` |
| `apps/client/src/ee/components/manage-hostname.tsx`、`joined-workspaces.tsx` | 跨 hostname 的 `/home`、`/` 套 `withPublicPath()` |

merge 策略:這幾處 upstream 改動頻繁。原則見 `2026-07-10` 文件的「修正規則」:寫入瀏覽器 URL 用 `withPublicPath()`;交給 React Router 的用裸 router path;外部 IdP/checkout URL **不套**前綴。

### 建置與伺服器端

| 檔案 | 改動 | merge 策略 |
|---|---|---|
| `apps/client/vite.config.ts` | `base: normalizeBasePath(publicPathPrefix)`;dev proxy 已含 `/api`、`/socket.io`、`/collab` | 保留 fork 的 `base`;upstream 動 dev proxy 時合併 |
| `apps/server/src/integrations/static/static.module.ts` | `normalizePublicPathPrefix()`、`prefixIndexAssetUrls()` 改寫 index.html 的 `/assets`、`/icons`、`manifest.json`;注入 `window.CONFIG.DOCMOST_PUBLIC_PATH_PREFIX`;根路徑與帶前綴都註冊靜態服務;SPA fallback | upstream 只服務根路徑靜態檔、不改寫資產前綴 | **中衝突風險**。保留 fork 的前綴改寫與 window.CONFIG 注入;upstream 若新增 window.CONFIG 欄位,兩邊合併(對照 `static.module.spec.ts`) |

**後端刻意不改(rebase 時若看到「差異」代表 upstream 動了別的,不是前綴的鍋):**
`apps/server/src/main.ts` 的 `setGlobalPrefix('api')`、socket.io Redis adapter、
`collaboration.module.ts` 的 `/collab` server path —— 全維持 upstream 原樣。

## Merge / rebase 後的驗證

1. 前端型別:`cd docmost && npx tsc --noEmit -p apps/client/tsconfig.json`(注意 `apps/server` 有 2 個 redis-sync 既有錯誤,與此無關)。
2. 防回歸 grep(見 `2026-07-10-public-path-prefix-api-wiring.md` §防回歸檢查):
   ```bash
   rg -n 'fetch\(["'"'"']/api|window\.location\.(href|replace).*APP_ROUTE' apps/client/src
   rg -n 'io\(|new WebSocket\(|HocuspocusProvider' apps/client/src
   ```
   任何新出現的裸 `/api`、裸 `/socket.io`、裸 `/collab`、或用裸路徑比對 `window.location` 的地方,都要補 helper。
3. 重 build client 後,`DOCMOST_PUBLIC_PATH_PREFIX=/wiki` 部署,DevTools → Network → WS 應看到
   `/wiki/socket.io/` 與 `/wiki/collab` 皆 `101 Switching Protocols`;console 無 reconnect loop。
4. `DOCMOST_PUBLIC_PATH_PREFIX=`(留空)部署一次,確認所有行為退回根路徑,證明改動向後相容。
