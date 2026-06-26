# Docmost 網段來源權限設計書

狀態: draft
建立日期: 2026-06-25
專用 todo: [docmost-network-origin-permissions-todo.md](./docmost-network-origin-permissions-todo.md)

## 1. 需求摘要

Page 和 attachment 建立時需要記錄「生成/上傳來源地址」。在使用者本身已具備對應動作權限的前提下，再加一層網段來源權限:

- 100 網段（內網）請求: 可以執行所有既有權限允許的動作。
- 非 100 網段請求建立的 page / attachment: 只能由同一原網段執行導出、下載、printPDF。
- 這層規則不可放大權限；它只在原本 page/space/workspace 權限已通過後，進一步拒絕跨網段敏感輸出動作。

## 2. 權限模型

新增的權限層命名為 `NetworkOriginPolicy`，位於既有權限檢查之後:

```text
JWT / workspace
  -> space ability
  -> page restriction / attachment owner page visibility
  -> NetworkOriginPolicy for export/download/printPDF
```

### 動作分類

| 動作 | 既有前提 | 新增網段檢查 |
| --- | --- | --- |
| Page 查看 | `validateCanView` | 不限制 |
| Page 編輯 | `validateCanEdit` | 不限制；更新不改寫原始生成網段 |
| Page 建立 | space create 或 parent edit | 記錄來源地址與來源網段 |
| Attachment 上傳 | page edit | 記錄來源地址與來源網段 |
| Attachment 下載 / 預覽 | page view 或 chat owner | 限制 |
| Attachment info | page view | 可回傳 metadata；若 UI 依此觸發下載，仍由下載路由限制 |
| Page export | page view | 限制 root page；includeChildren 時逐頁過濾或拒絕，見 §5 |
| Space export | space admin | 限制每一頁與附件；預設遇到不允許項目即拒絕 |
| printPDF / server PDF export | page view | 限制 |
| 瀏覽器 `window.print()` | page view | 前端可隱藏；真正安全控制需導向 server printPDF 流程 |

### 判斷規則

定義:

- `requestNetwork`: 從請求 IP 算出的網段。
- `resourceOriginNetwork`: page 或 attachment 建立時記錄的來源網段。
- `internalNetwork`: 設定中的 100 網段，預設 `100.0.0.0/8`。

判斷:

```text
allow(action, resource, request):
  if action not in [export, download, printPDF]:
    return true

  if requestNetwork is internalNetwork:
    return true

  if resourceOriginNetwork is empty:
    return legacyUnknownOriginPolicy

  return requestNetwork == resourceOriginNetwork
```

`legacyUnknownOriginPolicy` 預設建議為 `allow`，避免升級後舊資料突然不可下載；可用環境變數切成 `deny` 供高安全部署使用。

## 3. 網段定義

### 100 網段

預設使用 CIDR:

```text
DOCMOST_INTERNAL_CIDRS=100.0.0.0/8
```

如實際內網是多段，可用逗號分隔:

```text
DOCMOST_INTERNAL_CIDRS=100.0.0.0/8,10.0.0.0/8,192.168.0.0/16
```

本需求中的「100 網段」先按 IPv4 `100.0.0.0/8` 實作。若公司語境實際指 `100.x.x.x` 之外的內網，需要在部署設定中調整。

### 原網段粒度

建議用可配置 CIDR 粒度計算來源網段:

```text
DOCMOST_ORIGIN_NETWORK_MASK_V4=24
DOCMOST_ORIGIN_NETWORK_MASK_V6=64
```

例: `172.20.8.53` 記為 `172.20.8.0/24`。這比記錄完整 IP 更穩定，也能符合「原網段」而非「同一台機器」。

## 4. 資料模型

在 `pages` 與 `attachments` 加入欄位:

```text
origin_ip              inet nullable
origin_network         cidr nullable
origin_network_scope   varchar nullable  -- internal | external | unknown
origin_recorded_at     timestamptz nullable
```

備註:

- PostgreSQL `inet` / `cidr` 適合查詢與儲存 IP/CIDR；Kysely 型別可先用 string 表示。
- `origin_network_scope=internal` 表示建立請求來自內網 CIDR；它本身不代表資源可被外網跨網段輸出。
- 更新 page 或覆寫 attachment 檔案時，預設不改寫來源欄位；來源代表初次生成/上傳位置。
- 若要支援「重新歸屬來源網段」，應另做 admin-only 維護功能與 audit log，不在第一版範圍。

## 5. 後端落點

### 請求 IP 解析

新增 `NetworkOriginService`:

- 從 Fastify request 解析 client IP。
- 預設使用 `req.ip`。
- 只有在 `TRUST_PROXY=true` 或等價設定啟用時，才接受 `X-Forwarded-For` / `X-Real-IP`。
- 對多層 proxy，取最左側可信 client IP 前需搭配 trusted proxy 設定，避免 header 偽造。

### Page 建立

落點:

- `apps/server/src/core/page/page.controller.ts`
- `apps/server/src/core/page/services/page.service.ts`
- `apps/server/src/database/repos/page/page.repo.ts`

流程:

1. `POST /pages/create` 取得 request origin。
2. 建立 page 時寫入 `originIp`、`originNetwork`、`originNetworkScope`、`originRecordedAt`。
3. duplicate/import/transclusion 產生的新 page 也要明確選擇來源策略:
   - 使用當前請求來源作為新 page 來源。
   - 匯入保留外部 metadata 的需求另議，第一版不保留外部來源。

### Attachment 上傳

落點:

- `apps/server/src/core/attachment/attachment.controller.ts`
- `apps/server/src/core/attachment/services/attachment.service.ts`
- `apps/server/src/database/repos/attachment/attachment.repo.ts`

流程:

1. `POST /files/upload` 在 `validateCanEdit` 通過後取得 request origin。
2. 新 attachment 寫入來源欄位。
3. 覆寫既有 attachment 時不改寫來源欄位。
4. chat attachment 若需要下載，也應記錄來源並套用同一下載限制；若產品上不需要跨網段限制 chat 檔，需明確排除。

### Attachment 下載

落點:

- `GET /files/:fileId/:fileName`
- `GET /files/public/:fileId/:fileName`

流程:

1. 保持既有 page view / chat owner / public jwt 檢查。
2. 呼叫 `NetworkOriginPolicy.assertCanDownloadAttachment(attachment, req)`。
3. 不通過時回 `403 Forbidden`，audit 記錄 blocked reason。

Public share 注意:

- public jwt 只證明 attachment 屬於被分享 page，不應跳過網段來源限制。
- 如果外網分享必須可下載，應由產品開關顯式允許，不在第一版預設。

### Page / Space export

落點:

- `apps/server/src/integrations/export/export.controller.ts`
- `apps/server/src/integrations/export/export.service.ts`

建議第一版採「嚴格拒絕」:

- page export: root page 不允許則整個 export 403。
- includeChildren: 任一被納入的 child page 不允許 export，整個 export 403，回傳 blocked page count。
- includeAttachments: 任一附件不允許 download/export，整個 export 403。
- space export: 任一 page 或附件不允許 export，整個 export 403。

之後可增加「自動略過不允許項目」模式，但容易造成使用者以為匯出完整，第一版不建議。

### printPDF

現況:

- 前端 header 目前有 `window.print()`，它只依賴已載入頁面內容。
- client 有 `/pdf-render/:pageId`，會呼叫 `/api/pdf-export/render`，但目前 server 端 EE pdf-export controller 不在倉庫源碼中。

設計:

- 若存在 server PDF export/render endpoint，必須在 render token 發放與 render data 取得兩處套用 `NetworkOriginPolicy.assertCanPrintPage`。
- 前端 `window.print()` 只能做 UX 隱藏，不算安全邊界。
- 若必須嚴格禁止外網跨網段列印，需把列印入口改成 server-mediated printPDF，並對普通頁面視圖加上列印 CSS/快捷鍵防護提示；但瀏覽器層無法可靠阻止使用者對已可見內容截圖或列印。

## 6. 前端落點

前端只負責減少不可用操作:

- page header menu: export / printPDF 按鈕根據服務端回傳 capability 隱藏或 disabled。
- attachment view: download 按鈕可根據 attachment info 的 `networkRestricted` 狀態 disabled。
- export modal: 若目前 request network 對 root page 不允許，提前提示。

真正授權全部以後端為準。前端不要自行根據 IP 判斷。

可新增 capability endpoint:

```text
POST /pages/network-permissions
body: { pageId }
response: {
  canExport: boolean,
  canPrintPdf: boolean,
  requestNetworkScope: "internal" | "external" | "unknown",
  blockedReason?: "origin_network_mismatch" | "unknown_origin_denied"
}
```

第一版也可不做 endpoint，直接讓敏感動作後端 403；UI 優化排第二階段。

## 7. Audit / 診斷

新增或復用 audit metadata:

- 成功: `originNetwork`、`requestNetwork`、`action`。
- 阻擋: `resourceType`、`resourceId`、`originNetwork`、`requestNetwork`、`reason`。

建議新增內部 log event:

```text
NETWORK_ORIGIN_PERMISSION_BLOCKED
```

若 audit enum 不方便擴充，可先在 controller logger 中結構化輸出，並在 todo 中追蹤正式 audit 補齊。

## 8. 舊資料與遷移

遷移新增 nullable 欄位，不回填。

策略:

- 舊 page / attachment 的來源欄位為 null。
- 預設 `DOCMOST_UNKNOWN_ORIGIN_POLICY=allow`。
- 高安全部署可設 `deny`，舊資料需由管理員批次回填 origin network。

可提供一次性 SQL:

```sql
UPDATE pages
SET origin_network = '100.0.0.0/8',
    origin_network_scope = 'internal',
    origin_recorded_at = now()
WHERE origin_network IS NULL;
```

實際回填值必須由資料擁有者確認，不應在 migration 中自動假設。

## 9. 測試策略

### Unit tests

- `NetworkOriginService`:
  - IPv4 CIDR 判斷。
  - 100 網段 internal 放行。
  - external 同網段放行、不同網段拒絕。
  - unknown origin allow/deny 模式。
  - proxy header 只在 trust proxy 時生效。

- `AttachmentController`:
  - 已有 view 權限 + internal 下載成功。
  - 已有 view 權限 + external 同網段成功。
  - 已有 view 權限 + external 不同網段 403。
  - 無 page view 權限仍 403，不因 internal 放大。

- `ExportController/Service`:
  - root page mismatch 403。
  - includeChildren 中 child mismatch 403。
  - includeAttachments 中 attachment mismatch 403。

### E2E / live

- 從 `100.x.x.x` 模擬請求: export/download/printPDF 全通過（前提是使用者有權限）。
- 從 `172.20.8.x` 建立 page/attachment，再從 `172.20.8.y` 下載成功。
- 從 `172.20.8.x` 建立 page/attachment，再從 `172.20.9.y` 下載/export/printPDF 失敗。
- 使用者無原權限時，即使來自 100 網段仍失敗。

## 10. 未決問題

- 「100 網段」是否固定 `100.0.0.0/8`，還是公司內網有更精確 CIDR 清單？
- 「原網段」粒度是否使用 `/24`，或需要由部署方設定為 `/16`、完整 IP、或多 CIDR？
- 非 100 網段建立的 page，是否只限制 export/printPDF，不限制單純查看？本設計按需求文字採「不限制查看」。
- Space export 遇到部分 page/attachment 不允許時，是整包拒絕，還是略過並產生 manifest？本設計第一版採整包拒絕。
- Chat attachment 是否也屬於 attachment 下載限制？本設計建議納入。
