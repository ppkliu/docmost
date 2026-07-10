# 子路徑前綴(Public Path Prefix)— 前端 API 接線

狀態:核心已修復,尚有待辦
日期:2026-07-10

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

## 集中修正「沒有」涵蓋的待辦

以下這些繞過了共用 axios client,仍然把裸 `/api` 寫死。它們只在對應的 EE 功能
(AI / PDF 匯出)才會用到。`fetch()` 沒有 `baseURL` 概念,所以每一處都得個別包起來,
例如 `fetch(withPublicPath("/api/ai/chats/send"), …)`。日後要自建對應版本時,先參考 EE
實作,再套用同樣的包法。

| 檔案 | 行 | 裸路徑 | 功能 |
|---|---|---|---|
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts` | 76 | `/api/ai/chats/send` | AI 對話送出 |
| `apps/client/src/ee/pdf-export/pdf-render-page.tsx` | 27 | `/api/pdf-export/render` | PDF 匯出 |
| `apps/client/src/ee/ai/services/ai-search-service.ts` | 22 | `/api/ai/answers` | AI 搜尋 |
| `apps/client/src/ee/ai/services/ai-service.ts` | 24 | `/api/ai/generate/stream` | AI 生成(串流) |

### 需再確認(多半沒問題)

以下這兩處會組出 `/api/files/...` 的 URL 字串,但通常在渲染時會再經過 `getFileUrl()`
(已帶前綴)。使用前請先確認它們不是被「直接原字串」拿去用(例如直接下載連結),再放心:

| 檔案 | 行 |
|---|---|
| `apps/client/src/features/editor/components/common/editor-paste-handler.tsx` | 204 |
| `apps/client/src/features/search/components/search-result-item.tsx` | 42 |

另外 `apps/client/src/ee/utils.ts:15` 會針對**不同 hostname**(`getHostnameUrl`)組出
`/api/auth/exchange` 的 URL —— 那是跨網域的問題,與本篇的子路徑議題不同。
