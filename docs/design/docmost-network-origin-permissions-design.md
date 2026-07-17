# Docmost 網段來源權限設計書

狀態: draft (2026-07-03 修訂 v2)
建立日期: 2026-06-25
專用 todo: [docmost-network-origin-permissions-todo.md](./docmost-network-origin-permissions-todo.md)

## 修訂記錄

- 2026-06-25 v1: 初版。同源網段(same-subnet)判斷模型。
- 2026-07-03 v2: 依業務確認修訂六項決策(G1–G6，詳見 todo「設計修改記錄」):
  1. 判斷規則從「same-subnet」改為 **zone-based**(§2)，新增 `DOCMOST_OFFICE_CIDRS`。
  2. 網域判別採**混合**: 雙入口(Caddy 分內網/辦公網入口注入受信 header) + client IP CIDR 雙重驗證(§3)。
  3. 圖片**嵌入瀏覽放行、下載阻擋**(§5 下載豁免規則)。
  4. page import(pages/import、import-zip、import-files)納入來源記錄入口(§5)。
  5. MrDoc 遷移存量標記 `origin_network_scope='mrdoc'`，政策上等同內網專屬，日後可重分類(§4/§8)。
  6. 列印 PDF **不做專用攔截**，以檔案層防線為準(§5 printPDF；todo P4.7 關閉)。

## 1. 需求摘要

Page 和 attachment 建立時需要記錄「生成/上傳來源地址」。在使用者本身已具備對應動作權限的前提下，再加一層網段來源權限:

- 內網（internal zone）請求: 可以執行所有既有權限允許的動作。
- 內網上傳的 attachment / 內網建立的 page: 只能從內網下載/導出；辦公網一律 403。
- 辦公網（office zone）上傳/建立的資源: 內網與辦公網皆可下載/導出。
- MrDoc 遷移存量(scope=`mrdoc`): 視同內網專屬，待日後重分類。
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
| Attachment 下載 / 預覽 | page view 或 chat owner | 限制；**例外: 圖片嵌入渲染放行**(mime `image/*` 且 `Sec-Fetch-Dest: image`，見 §5) |
| Attachment info | page view | 可回傳 metadata；若 UI 依此觸發下載，仍由下載路由限制 |
| Page import(import / import-zip / import-files) | space create | 記錄來源；所產生的 page/attachment 繼承匯入請求的來源網段 |
| Page export | page view | 限制 root page；includeChildren 時逐頁過濾或拒絕，見 §5 |
| Space export | space admin | 限制每一頁與附件；預設遇到不允許項目即拒絕 |
| printPDF / `window.print()` | page view | **不做專用攔截**(2026-07-03 決策): 列印為純前端動作，受限檔案因檔案層防線本就載不出來，印出的 PDF 自然不含受限內容 |

### 判斷規則(2026-07-03 v2: zone-based)

定義:

- `requestZone`: 請求所屬 zone，由「入口 header + client IP CIDR」混合判定(§3): `internal` | `office` | `unknown`。
- `resourceScope`: 資源建立時記錄的 `origin_network_scope`: `internal` | `external`(辦公網) | `mrdoc` | null。
- `origin_network`(/24 明細)自 v2 起**只作稽核記錄，不參與判斷**。

判斷:

```text
allow(action, resource, request):
  if action not in [export, download]:
    return true

  if requestZone == internal:
    return true                      # 內網客戶端全放行(既有權限仍先行把關)

  # 以下 requestZone 為 office 或 unknown
  if requestZone == unknown:
    return false                     # 不在內網也不在辦公網 CIDR 清單 → 拒絕

  switch resourceScope:
    internal, mrdoc -> return false  # 內網專屬，辦公網不可取
    external        -> return true   # 辦公網上傳 → 全辦公網可取
    null            -> return unknownOriginPolicy   # 預設 allow(存量將回填為 mrdoc，剩餘 null 極少)
```

與 v1 的差異: v1 對辦公網客戶端要求「uploader 與 requester 同 /24」；v2 改為看資源 scope，辦公網上傳的資源任何辦公網客戶端皆可下載(業務 2026-07-03 確認)。

`unknownOriginPolicy` 預設 `allow`，避免升級後舊資料突然不可下載；可用環境變數切成 `deny` 供高安全部署使用。

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

### 辦公網(office zone，v2 新增)

```text
DOCMOST_OFFICE_CIDRS=<辦公網 CIDR 清單，逗號分隔>   # 部署時由業務提供
```

不落在 internal 也不落在 office CIDR 內的請求 zone 為 `unknown`，敏感動作一律拒絕。

### 混合入口判別(v2 新增，G1；2026-07-03 已實作，Phase 8)

網域判別採「雙入口 + CIDR」混合:

1. Caddy 以兩個入口(預設 `:80` 內網 / `:${OFFICE_ENTRANCE_PORT:-8081}` 辦公網,可改成兩個 domain)分別服務內網與辦公網。落點:`wuji-adapter/deploy/Caddyfile`,以 `(wuji_routes)` snippet + `{args[0]}` 參數共用同一套路由規則,避免兩份入口各寫一次。
2. 每個入口在轉發到 docmost 的 catch-all `reverse_proxy` 上**注入受信 header** `X-Docmost-Entrance: internal|office`(`header_up X-Docmost-Entrance {args[0]}`),並在同一行**先剝除**客戶端自帶的同名 header(`header_up -X-Docmost-Entrance`)。
3. `NetworkOriginService.resolveZone()`(`apps/server/src/common/services/network-origin.service.ts`)判 zone 時做雙重驗證: header 宣告的 zone 與 client IP 所屬 CIDR **不需要求一致**才能用——一致時直接採用;不一致時記 warning log 並取**較嚴格者**(用 `ZONE_RANK`:internal=2 > office=1 > unknown=0,永遠取較低分的一方)。這個「取嚴格」規則本身就防偽造:偽造 header 只能讓自己被判定成更嚴格的 zone,無法藉此升權。
4. `DOCMOST_ENTRANCE_HEADER_REQUIRED`(預設 `false`,`EnvironmentService.getEntranceHeaderRequired()`)控制 header 缺席時的行為:`false`(單入口部署,向下相容)= 退回純 CIDR 判斷;`true`(已確認雙入口網路隔離生效)= 缺席視為可疑,直接判 unknown zone(防止繞過 Caddy 直打 docmost)。

**實作狀態**:程式碼、Caddy 設定、compose port 映射、`.env.example`/`.env.attach.example`/`.env.integrated.example` 均已完成,並用 `caddy validate` 與 `docker compose config` 驗證語法正確;`network-origin.service.spec.ts` 補了 5 個案例(共 16 tests)。**尚未生效**:實際的網路隔離(讓內網來源只連得到 `:80`、辦公網來源只連得到 office port)是機房防火牆/路由層的工作,加上 `DOCMOST_INTERNAL_CIDRS`/`DOCMOST_OFFICE_CIDRS` 仍是空值/佔位,這兩項需要業務提供實際值才能真正上線(P0.7)。在此之前,雙入口程式碼對現有單入口部署行為零影響。

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
origin_network_scope   varchar nullable  -- internal | external | mrdoc | unknown
origin_recorded_at     timestamptz nullable
```

`mrdoc`(v2 新增): 標示「由 MrDoc 遷移而來、上傳來源不可考」的存量資源；政策上等同 `internal`(內網專屬)，作為獨立值保留是為了日後找到辨識方法時能整批重分類，不與真正的內網上傳混淆。

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
2. **圖片嵌入豁免(v2，G3)**: 若 `attachment.mimeType` 為 `image/*` **且**請求帶 `Sec-Fetch-Dest: image`(瀏覽器 `<img>` 載入)，跳過網段檢查放行——業務確認「圖片看可以、下載不行」。此豁免屬防君子層級(業務已知悉): 看得到即拿得到，無法技術上根絕。非圖片附件、或 `Sec-Fetch-Dest` 非 `image` 的請求(直接開網址、另存、fetch 下載)照常檢查。
3. 呼叫 `NetworkOriginPolicy.assertCanDownloadAttachment(attachment, req)`。
4. 不通過時回 `403 Forbidden`，audit 記錄 blocked reason。

Public share 注意:

- public jwt 只證明 attachment 屬於被分享 page，不應跳過網段來源限制。
- 如果外網分享必須可下載，應由產品開關顯式允許，不在第一版預設。

### Page import(v2 新增，G4)

落點:

- `apps/server/src/integrations/import/import.controller.ts`(`POST /pages/import`、`/pages/import-zip`、`/pages/import-files`)
- `apps/server/src/integrations/import/file-task.controller.ts` 與 `processors/file-task.processor.ts`

流程:

1. import 請求進來時取得 request origin(同 upload)。
2. 同步 import(`/pages/import`)直接把 origin 寫入所建 page/attachment。
3. 非同步 import(zip/files → file task): 把 origin 快照(`originIp/originNetwork/originNetworkScope`)存進 `file_tasks` 或 task payload，背景 processor 建立 pages/attachments 時帶入——**不可**在背景 job 內重新解析 request(已無 request 上下文)。

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

設計(2026-07-03 v2 定案，G6):

- **不做列印專用攔截**。理由: 列印是瀏覽器對「已渲染內容」的本地動作，伺服器攔不到；而受限的圖片/附件在辦公網因檔案層防線(`GET /files/` 403)根本載不出來，印出的 PDF 自然不含受限內容。頁面文字本來就「能看就能印」，攔列印鈕沒有實質安全意義。
- 若日後出現 server-side PDF render endpoint(EE pdf-export),再套用 `assertCanPrintPage`(保留 API 但目前無呼叫點)。

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

## 8. 舊資料與遷移(2026-07-03 v2 修訂，G5)

背景: 已確認 MrDoc 來源庫(`app_doc_attachment`/`app_doc_image`)**沒有上傳 IP 欄位**，遷移資料的上傳來源不可考。

策略(業務 2026-07-03 決定):

- MrDoc 遷移存量統一標記 `origin_network_scope='mrdoc'`(`origin_ip`/`origin_network` 維持 null)，政策上**視同內網專屬**；日後找到辨識方法再整批重分類。
- 圈定範圍靠遷移工具自建的映射表: `mig_attachment_map`、`mig_image_map`(attachments)與 `mig_page_map`(pages)。
- 其餘非遷移來源的 null 存量走 `DOCMOST_UNKNOWN_ORIGIN_POLICY`(維持 `allow`)。

落點:

1. **回填 SQL**(idempotent，對已完成遷移的庫執行一次): `migration/mrdoc-to-docmost/sql/backfill_origin_mrdoc.sql`，靠 `mig_attachment_map`/`mig_image_map`/`mig_page_map` 精準鎖定遷移列，只補 `origin_network_scope IS NULL` 的列。包裝腳本: `migration/mrdoc-to-docmost/backfill-origin.sh [env-file]`。
2. **遷移工具增補**(已完成): `migration/mrdoc-to-docmost/sql/02_migrate_metadata.sql` 在 INSERT attachments(含圖片)/pages 時直接寫入 `origin_network_scope='mrdoc'` + `origin_recorded_at=now()`，讓日後再跑的遷移不需事後回填；`ON CONFLICT DO UPDATE` 不覆寫既有列的 scope,保留人工重分類結果。
3. **重分類工具**(已完成): `migration/mrdoc-to-docmost/sql/reclassify_origin.sql` 提供按 space / 上傳者 / 時間區間 / UUID 清單批次改 scope 的範本(需人工複製條件後執行,不自動跑)；admin UI 不在本版範圍。
4. **驗證**(已完成): `migration/mrdoc-to-docmost/verify-attachments.sh` 第 7 項統計遷移附件的 `origin_network_scope` 標記覆蓋率。

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

已於 2026-07-03 定案:

- ~~跨網段語義~~ → zone-based(§2)；辦公網上傳全辦公網可下載。
- ~~Space export 部分拒絕~~ → 整包拒絕(業務確認「整篇阻擋」)。
- ~~列印控制~~ → 檔案層防線即可，不做專用攔截(G6)。
- ~~舊資料回填~~ → MrDoc 存量標 `mrdoc` 視同內網(G5)。
- ~~圖片瀏覽~~ → 嵌入顯示放行、下載阻擋(G3)。

仍待部署期確認:

- `DOCMOST_INTERNAL_CIDRS` 與 `DOCMOST_OFFICE_CIDRS` 的實際 CIDR 清單(業務提供)。
- 雙入口的實體形式(不同 domain 或不同 bind IP/port)與 Caddy 部署位置(`wuji-adapter/deploy/Caddyfile` 或獨立 Caddy)。
- Chat attachment 納入限制(v1 已納入，維持)。

## 11. 圖片瀏覽改為全網段放行(2026-07-16 修訂 G3)

### 背景

原 G3 設計為「圖片嵌入顯示放行、下載阻擋」,靠 `isImageEmbedRequest()` 判斷
`mime_type` 為 `image/*` 且請求帶 `Sec-Fetch-Dest: image` 才略過 network-origin 檢查。
實務上部署在外層 nginx 之後時,`Sec-Fetch-*` 標頭常被外層濾掉,導致辦公網(office zone)
瀏覽 MrDoc 遷移圖片(`origin_network_scope='mrdoc'`)時,嵌入顯示也被判 403(破圖)。

### 修訂

新增 env 開關 `DOCMOST_IMAGE_VIEW_IGNORE_NETWORK_ORIGIN`(**預設 `true`**):
為 true 時,`isImageEmbedRequest()` 對「任何 `image/*` 附件」都回 true,亦即
**圖片一律不受 zone 規則限制,內網與辦公網都能瀏覽**,不再依賴 `Sec-Fetch-Dest`。
非圖片附件(pdf/office/zip…)維持原 zone 阻擋。設為 `false` 可還原成只放行
`Sec-Fetch-Dest: image` 的嵌入請求。

程式變更:
- `apps/server/src/integrations/environment/environment.service.ts` — 新增 `getImageViewIgnoreNetworkOrigin()`。
- `apps/server/src/core/attachment/attachment.controller.ts` — `isImageEmbedRequest()` 依此開關短路回 true。

安全說明:原設計註解已載明此豁免「非安全邊界——可顯示即可複製」,故放寬圖片顯示範圍
不改變資安模型;真正需要阻擋的敏感檔案應為非圖片附件,仍受 zone 規則保護。
