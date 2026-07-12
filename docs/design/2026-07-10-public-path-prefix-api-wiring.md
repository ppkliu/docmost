# 子路徑前綴(Public Path Prefix)— 前端 API 接線

狀態:已完成
日期:2026-07-10；補完:2026-07-12

## 背景

當 Docmost 掛在子路徑下部署(`DOCMOST_PUBLIC_PATH_PREFIX=/wiki`)時,最外層反向代理
只會把 `/wiki/*` 轉給 Docmost 這一疊(Caddy → server)。任何**沒帶** `/wiki` 前綴
到達外層代理的請求,都會留在外層命名空間(例如無極的 `/api`),永遠到不了 Docmost
——瀏覽器只會收到 `405`/HTML,且回應**沒有** `Via: Caddy` 標頭。

前端其實早就備好了整套前綴機制,只是沒接上:

- `getPublicPathPrefix()` 讀 `window.CONFIG.DOCMOST_PUBLIC_PATH_PREFIX`(由 server 的
  `StaticModule` 在啟動時,從 `process.env.DOCMOST_PUBLIC_PATH_PREFIX` 於執行期注入)。
- `getBackendUrl()` = `origin + 前綴 + "/api"`。
- `withPublicPath(path)` 幫路徑補上前綴(前綴為空時等同不變)。

……但共用的 axios client 從來沒用到它們。

## 根本原因

`apps/client/src/lib/api-client.ts` 把 `baseURL` 寫死成 `"/api"`。所有 REST 呼叫都經過
這個唯一的 axios 實例,因此**全部** API 流量都忽略前綴、直接打裸 `/api/...` → 外層代理 `405`。

## 修正(已完成)

單一集中修改 —— 涵蓋所有經過共用 client 的約 179 個 REST 端點:

- `baseURL: "/api"` → `baseURL: getBackendUrl()`
- 回應攔截器裡的路徑字串比對改成前綴感知,才能在 `/wiki` 下仍然對得上:
  - `exemptEndpoints`(`/api/pages/export`、`/api/spaces/export`)→ 用 `withPublicPath(...)` 包起來
  - collab-token 的 401 例外 `=== "/api/auth/collab-token"` → `=== withPublicPath("/api/auth/collab-token")`

當前綴為空時,以上全部退回原本的裸路徑,因此對根路徑部署完全向後相容。

驗證(在 server 上,重建前端 + 硬重整後):
`curl -sI -X POST $BASE/wiki/api/users/me` → `401` + `Via: 1.1 Caddy`(已到 Docmost);
裸路徑 `$BASE/api/users/me` → `405`(被外層代理擋下)。

## 繞過共用 client 的 API(已完成)

以下 `fetch()` 繞過共用 axios client，原本仍把裸 `/api` 寫死。它們已全部改為
`fetch(withPublicPath("/api/..."), …)`，因此根路徑與 `/wiki` 部署都會落到正確 backend。

| 檔案                                                     | 行  | 裸路徑                    | 功能          |
| -------------------------------------------------------- | --- | ------------------------- | ------------- |
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts` | 76  | `/api/ai/chats/send`      | AI 對話送出   |
| `apps/client/src/ee/pdf-export/pdf-render-page.tsx`      | 27  | `/api/pdf-export/render`  | PDF 匯出      |
| `apps/client/src/ee/ai/services/ai-search-service.ts`    | 22  | `/api/ai/answers`         | AI 搜尋       |
| `apps/client/src/ee/ai/services/ai-service.ts`           | 24  | `/api/ai/generate/stream` | AI 生成(串流) |

## 登入、登出與 redirect basename 循環(已完成)

### 症狀

`/wiki/login?redirect=%2Fwiki%2Fhome` 會持續重新載入，console 顯示：

```text
<Router basename="/wiki"> is not able to match the URL "/login..."
```

### 根因

- 401 interceptor 用 `window.location.pathname`（含 `/wiki`）和裸 `/login` 比較，因而
  沒把 `/wiki/login` 視為免重導頁。
- interceptor 把含 basename 的 `/wiki/...` 寫進 `redirect` query；登入後再交給
  React Router `navigate()`，可能形成 `/wiki/wiki/...`。
- logout、workspace-not-found setup redirect 使用 `window.location`，繞過 React Router，
  但沒有用 `withPublicPath()`。

### 修正規則

- 寫入瀏覽器 URL：`withPublicPath(APP_ROUTE...)`。
- 傳給 React Router `navigate()` 或放入 `redirect` query：使用不含 basename 的 router path。
- 從 `window.location.pathname` 取得 router path：先呼叫 `stripPublicPath()`。
- share/login/setup 的 pathname 比對必須在同一個路徑空間比較，不可混用裸路徑與瀏覽器路徑。

`getPostLoginRedirect()` 與 `getRedirectParam()` 也會移除既有 `/wiki`，兼容舊書籤或
已經帶前綴的 SSO redirect。

## SSO 與跨 hostname URL(已完成)

- 當前 origin 的 SAML/OIDC callback、login、entity ID 改用 `getPublicBaseUrl()`。
- Google instance-wide URL 繼續使用 canonical `APP_URL`；該值必須包含 `/wiki`。
- 跨 hostname 的 verify-email、exchange-token、workspace home 與 hostname 切換補上
  `withPublicPath()`。

雙 host 同時開放非 Google SSO 時，IdP 必須註冊兩個 callback origin（都含 `/wiki`）；
若 IdP 只允許一個 callback，應只讓 canonical WUJI host 顯示該 SSO provider，Wiki direct
host 改用原生登入或導回 canonical host。

## 仍需確認(多半沒問題)

以下這兩處會組出 `/api/files/...` 的 URL 字串,但通常在渲染時會再經過 `getFileUrl()`
(已帶前綴)。使用前請先確認它們不是被「直接原字串」拿去用(例如直接下載連結),再放心:

| 檔案                                                                         | 行  |
| ---------------------------------------------------------------------------- | --- |
| `apps/client/src/features/editor/components/common/editor-paste-handler.tsx` | 204 |
| `apps/client/src/features/search/components/search-result-item.tsx`          | 42  |

## 防回歸檢查

新增或審查前端程式時執行：

```bash
rg -n 'fetch\(["'"']/api|window\.location\.(href|replace).*APP_ROUTE' apps/client/src
```

判斷原則：

- `fetch("/api/...")`：錯誤，應使用 `withPublicPath()` 或共用 API client。
- `window.location` + 站內路徑：應使用 `withPublicPath()`。
- React Router `navigate()` / `<Link to>`：維持裸 router path，由 basename 自動處理。
- 外部 checkout/IdP URL：不應套 public path。

驗證矩陣：

| 場景                           | 預期                                             |
| ------------------------------ | ------------------------------------------------ |
| `/wiki/login` 收到背景 API 401 | 停留原頁，不重導                                 |
| `/wiki/settings` 未登入        | `/wiki/login?redirect=%2Fsettings`               |
| 登入成功                       | `/wiki/settings`，不可出現 `/wiki/wiki/settings` |
| 登出                           | `/wiki/login?logout=1`                           |
| workspace 不存在               | `/wiki/setup/register`                           |
| AI/PDF fetch                   | 請求 `/wiki/api/...`                             |
| `DOCMOST_PUBLIC_PATH_PREFIX=`  | 所有行為退回根路徑，保持向後相容                 |
