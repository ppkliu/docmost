# Docmost 網段來源權限 Todo

狀態: draft
設計書: [docmost-network-origin-permissions-design.md](./docmost-network-origin-permissions-design.md)
最後更新: 2026-07-03(v2 核心 + Phase 8 混合入口實作完成)

Legend: ✅ done · 🟡 in progress/partial · ⬜ todo · ⚠ blocked/decision needed · ✖ won't do

## 設計修改記錄

- 2026-06-25: 建立專用設計書與專用 todo。初版決策: 網段權限只作為既有權限後的二次限制；100 網段放行所有既有權限允許的敏感輸出動作；非 100 網段資源只允許同原網段 download/export/printPDF。
- 2026-06-25: 初版建議舊資料 `origin_network` 為 null 時預設 allow，避免升級後破壞既有下載；高安全部署可改成 deny 並批次回填。
- 2026-06-25: 後端第一版完成: DB 欄位、`NetworkOriginService`、page create/duplicate 來源記錄、attachment/chat attachment upload 來源記錄、attachment private/public download 限制、page/space export 限制；server `tsc --noEmit` 與 service unit tests 通過。
- 2026-07-03: 業務確認六項決策(設計書 v2，G1–G6):
  - G1 網域判別採混合: Caddy 雙入口注入受信 header + client IP CIDR 雙重驗證(新 Phase 8)。
  - G2 政策改 zone-based: 辦公網上傳→全辦公網可下載；新增 `DOCMOST_OFFICE_CIDRS`；`origin_network` 改純稽核(P2.6–P2.8)。
  - G3 圖片嵌入渲染豁免(`image/*` + `Sec-Fetch-Dest: image`)，下載照擋(P4.9)。
  - G4 page import 納入來源記錄，origin 隨 file task 傳遞(P3.2/P3.6)。
  - G5 MrDoc 遷移存量標 `origin_network_scope='mrdoc'` 視同內網，日後可重分類(新 Phase 9)。
  - G6 列印 PDF 不做專用攔截，檔案層防線為準(P4.7 關閉)。
  - 匯出語義維持整包拒絕(P0.4 再確認)。
- 2026-07-03(實作): 完成 P2.6–P2.9(zone-based 核心)、P4.9(圖片嵌入豁免)、Phase 9(MrDoc 存量標記全套)、P3.6(import 來源接線)。`tsc --noEmit`(server)僅剩 2 個與本次修改無關的既有錯誤(`redis-sync.*`);`network-origin.service.spec.ts`(11 tests)與 `import.service.spec.ts`(1 test)均通過。Phase 8(混合入口)與 Phase 5/6/7(前端/audit/live 驗證)未動,見下方狀態。
- 2026-07-03(實作,續): 完成 Phase 8 全部(P8.1–P8.4)——雙入口 Caddy 設定 + `NetworkOriginService` 混合判定 + deploy 文件/env 範例。**程式碼與部署腳本層面已就緒**,但實際啟用網路隔離(誰能連 :80、誰能連 office port)仍是業務/機房網路設定,且 `DOCMOST_INTERNAL_CIDRS`/`DOCMOST_OFFICE_CIDRS` 仍是空值/佔位,P0.7 仍待業務提供才能真正上線;在那之前這段程式碼對現有單入口部署零影響(已用 `docker compose config`/`caddy validate` 驗證)。`network-origin.service.spec.ts` 現為 16 tests,全過。

## 目前狀態

- ✅ 已盤點主要後端落點: page create/update、attachment upload/download/info、page/space export、PDF render/printPDF。
- ✅ 已確認現有權限前提: page/attachment 目前依 `PageAccessService` 與 space CASL 控制；新功能不可替代這些檢查。
- ✅ 已實作 DB migration。
- ✅ 已實作 `NetworkOriginService` zone-based 核心(v2 語義:internal/office/unknown zone × internal/external/mrdoc/null scope)。
- ✅ 已接入 controller/service: page create/duplicate/import(同步+file task)、attachment upload/download(含圖片嵌入豁免)、page/space export。
- ✅ 已補/更新核心 service unit tests(16 個案例涵蓋 zone×scope 矩陣 + 混合 header/CIDR 判定);import.service 既有 test 仍綠。
- ✅ Phase 8(混合入口)程式碼與部署腳本已完成(Caddyfile 雙入口、`NetworkOriginService` 混合判定、compose/env/文件)；預設對現有單入口部署無感,已用 `caddy validate`/`docker compose config` 驗證。
- ⬜ 尚未做: Phase 5(前端 UX)、Phase 6(audit event)、Phase 7 剩餘的 controller/export 整合測試與 live 驗證。
- ⚠ 部署值待業務提供: 內網/辦公網 CIDR 清單、雙入口是否走 port 還是網域(P0.7)——**只影響「真正啟用網路隔離」這一步**,不影響現有部署;沒有這些值之前,雙入口程式碼相當於休眠狀態。

## v2 實作順序與進度(2026-07-03)

1. ✅ **P2.6–P2.9** 政策核心改 zone-based(含 `mrdoc` scope、`DOCMOST_OFFICE_CIDRS`、tests)——其他項都依賴新語義。
2. ✅ **P4.9** 圖片嵌入豁免(小改，緊貼 file endpoint)。
3. ✅ **Phase 9** MrDoc 存量標記(純 SQL/遷移工具，與 docmost 代碼無耦合，可並行)。
4. ✅ **P3.6** import 來源接線(涉及 file task payload 傳遞，中等工作量)。
5. ✅ **Phase 8** 混合入口(Caddy + service 雙重驗證)——程式碼/腳本已完成,實際啟用網路隔離仍待 P0.7 部署資訊,在那之前對現有部署零影響。
6. ⬜ **Phase 5/6/7** 前端 UX、audit、整合與 live 驗證收尾——**下一步**。

## Phase 0 - 決策確認

- 🟡 P0.1 先以可配置預設實作: `DOCMOST_INTERNAL_CIDRS=100.0.0.0/8`；仍待業務確認實際內網 CIDR。
- ✅ P0.2 `origin_network` 粒度(v4 /24、v6 /64)自 v2 起僅稽核用，不參與判斷，粒度不再是阻塞決策。
- 🟡 P0.3 先以可配置預設實作: `DOCMOST_UNKNOWN_ORIGIN_POLICY=allow`；高安全部署可改 `deny`。
- ✅ P0.4 整包拒絕: space/page export 遇到任一不允許 page/attachment 即 403(2026-07-03 業務再確認)。
- ✅ P0.5 chat attachment 已納入同一下載限制；新 chat attachment 上傳時也記錄來源網段。
- ✅ P0.6 (2026-07-03) 判斷模型定案 zone-based，同源網段規則廢止。
- ⚠ P0.7 `DOCMOST_OFFICE_CIDRS` 實際清單與雙入口實體形式(domain/port)待業務/部署提供。

## Phase 1 - 資料模型

- ✅ P1.1 新增 migration: `pages.origin_ip inet`、`pages.origin_network cidr`、`pages.origin_network_scope varchar`、`pages.origin_recorded_at timestamptz`。
- ✅ P1.2 新增 migration: `attachments.origin_ip inet`、`attachments.origin_network cidr`、`attachments.origin_network_scope varchar`、`attachments.origin_recorded_at timestamptz`。
- ✅ P1.3 更新 DB 型別與 entity types。
- ✅ P1.4 更新 `PageRepo.baseFields` 與 insert/update DTO 型別。
- ✅ P1.5 更新 `AttachmentRepo.baseFields` 與 insert DTO 型別。

## Phase 2 - 核心服務

- ✅ P2.1 新增 `NetworkOriginService`: 解析 request IP、CIDR、scope。
- ✅ P2.2 新增設定: `DOCMOST_INTERNAL_CIDRS`、`DOCMOST_ORIGIN_NETWORK_MASK_V4`、`DOCMOST_ORIGIN_NETWORK_MASK_V6`、`DOCMOST_UNKNOWN_ORIGIN_POLICY`。
- ✅ P2.3 新增 trust proxy 行為，避免直接信任可偽造 header。
- ✅ P2.4 新增 `NetworkOriginPolicy`: `canExportPage`、`canPrintPage`、`canDownloadAttachment`。
- ✅ P2.5 補 unit tests: CIDR、internal、same-origin、mismatch、unknown allow/deny、proxy。
- ✅ P2.6 (G2) `isAllowed` 改 zone-based: 判 requestZone(internal/office/unknown)與 resourceScope(internal/mrdoc/external/null)，廢止 same-subnet 比對(設計書 §2 v2)。
- ✅ P2.7 (G2) 新增設定 `DOCMOST_OFFICE_CIDRS`(`EnvironmentService.getOfficeCidrs()`)；requestZone 不在 internal/office 清單 → unknown → 拒絕。
- ✅ P2.8 (G5) scope 值域擴充 `mrdoc`(政策等同 internal-only,`isAllowed` 對 office zone 一律拒絕 `internal`/`mrdoc`)。
- ✅ P2.9 更新 `network-origin.service.spec.ts`(11 tests): getRequestOrigin 三種 scope、getRequestZone、isAllowed 全 zone×scope 矩陣、trust proxy。

## Phase 3 - 寫入來源

- ✅ P3.1 `POST /pages/create` 寫入 page 來源欄位。
- ✅ P3.2 duplicate 已寫入當前請求來源；import 接線見 P3.6(已完成)。
- ✅ P3.3 `POST /files/upload` 新 attachment 寫入來源欄位；`POST /ai/chats/upload` 新 chat attachment 也寫入來源欄位。
- ✅ P3.4 attachment overwrite 不改寫既有來源欄位。
- ✅ P3.5 migration import 工具來源策略已完成(Phase 9): 標 `mrdoc`。
- ✅ P3.6 (G4) import 入口接線完成:
  - `ImportController`/`ImportService.importPage`: 同步寫入 origin 到 `pages` 表。
  - `ImportService.importZip`/`importBulkFiles`: origin 經 `originToFileTaskMetadata()` 存入 `fileTasks.metadata`(該欄位原本未使用,免加 migration)。
  - `FileImportTaskService.processGenericImport`: 用 `originFromFileTaskMetadata(fileTask.metadata)` 讀回，寫入每個 `insertablePage`。
  - `ImportAttachmentService`: 新增 `originFieldsFor(fileTask)` private helper，套用到兩個 `insertInto('attachments')` 呼叫點(SVG 內嵌圖 + 一般附件)。
  - 兩個序列化/反序列化函式集中在 `network-origin.service.ts`(`originToFileTaskMetadata`/`originFromFileTaskMetadata`),避免格式漂移。

## Phase 4 - 敏感動作限制

- ✅ P4.1 `GET /files/:fileId/:fileName` 加入 attachment download 網段檢查。
- ✅ P4.2 `GET /files/public/:fileId/:fileName` 加入 public attachment download 網段檢查。
- ✅ P4.3 `POST /pages/export` root page 加入 export 網段檢查。
- ✅ P4.4 `POST /pages/export` includeChildren 時檢查所有納入 page。
- ✅ P4.5 `POST /pages/export` includeAttachments 時檢查所有附件。
- ✅ P4.6 `POST /spaces/export` 檢查所有 page 與附件。
- ✖ P4.7 (G6 定案) 不做列印專用攔截: `window.print()` 為純前端動作，受限檔案在辦公網因檔案層防線載不出來，印出的 PDF 自然不含受限內容。若日後出現 server-side PDF render endpoint 再評估。
- ✅ P4.8 保證 100 網段只放行新網段層，不跳過原本 user/page/space 權限。
- ✅ P4.9 (G3) 圖片嵌入渲染豁免: `attachment.controller.ts` 新增 `isImageEmbedRequest()`，對 `mimeType image/*` 且 `Sec-Fetch-Dest: image` 的請求跳過網段檢查(嵌入顯示放行)；套用到 private 與 public 兩個 file 端點；其他請求(下載/另存/直開網址/非圖片)照常檢查。豁免屬防君子層級，業務已知悉。

## Phase 5 - 前端 UX

- ⬜ P5.1 決定是否新增 `POST /pages/network-permissions` capability endpoint。
- ⬜ P5.2 page header export / printPDF 按鈕顯示受 capability 控制。
- ⬜ P5.3 attachment download 按鈕處理 403 與可選 disabled 狀態。
- ⬜ P5.4 export modal 對網段拒絕顯示明確錯誤。

## Phase 6 - Audit 與文件

- ⬜ P6.1 成功 export/download/printPDF audit metadata 加入 `originNetwork` / `requestNetwork`。
- ⬜ P6.2 阻擋事件加入 structured log 或正式 audit event。
- ⬜ P6.3 更新 `docmost/docs/PERMISSIONS-ARCHITECTURE.md`，加入網段來源權限層。
- ⬜ P6.4 更新使用手冊，說明 100 網段與原網段行為。

## Phase 7 - 驗證

- 🟡 P7.1 server unit tests 通過: `network-origin.service.spec.ts` 16 tests passed(zone-based + 混合 header/CIDR，P2.9/P8.4 已更新)、`import.service.spec.ts` 1 test passed；`tsc --noEmit`(apps/server)僅剩 2 個既有無關錯誤；尚未補 controller/export 整合測試。
- ⬜ P7.2 client typecheck 通過。
- ⬜ P7.3 live: 內網 request 有原權限時 download/export 成功。
- ⬜ P7.4 live: 辦公網上傳的檔案，從另一辦公網子網下載成功(zone-based 驗證)。
- ⬜ P7.5 live: 內網上傳/`mrdoc` 存量檔案，從辦公網下載/export 被 403。
- ⬜ P7.6 live: 無原權限但來自內網仍被拒絕。
- ⬜ P7.7 live: 含內網圖片的 page 在辦公網開啟，圖片嵌入正常顯示；同 URL 直接開新分頁/另存被 403(G3)。
- ⬜ P7.8 live: 雙入口交叉測試——辦公網 IP 打內網入口被降級處理並記 warning(G1)。
- ⬜ P7.9 live: 從辦公網 import zip，產生的 attachments scope=external；從內網 import 則 internal(G4)。

## Phase 8 - 混合入口(G1，v2 新增)

- ✅ P8.1 Caddy 雙入口設定(`wuji-adapter/deploy/Caddyfile`): 用 `(wuji_routes)` snippet 帶參數(`{args[0]}`)避免重複所有路由規則；`:80` import `internal`、`:${OFFICE_ENTRANCE_PORT:-8081}` import `office`；catch-all 轉給 docmost 時 `header_up -X-Docmost-Entrance` 先清客戶端偽造值再蓋上受信值。預設兩個入口都會啟動,但除非真的把 office port 對外開放並用防火牆/路由做網段隔離,行為與只有單入口時完全一致(向下相容)。`docker compose ... caddy validate` 已過。同步更新 `docker-compose.attach.yml`/`docker-compose.integrated.yml`(新增 `OFFICE_ENTRANCE_PORT`/`OFFICE_HTTP_PORT` port 映射,`docker compose config` 已驗證兩份都正確產生兩個 port mapping)與正式 TLS 範例(檔尾新增雙網域 import 寫法)。
- ✅ P8.2 `NetworkOriginService` 混合判定(`resolveZone`): 讀 `x-docmost-entrance` header,與 client IP CIDR 算出的 zone 比對;一致直接採用,不一致記 warning 並取「較嚴格」的一方(用 `ZONE_RANK` 排序,internal > office > unknown,永遠取較低者)——攻擊者用 header 只能把自己降級,無法藉此升權。新增 `EnvironmentService.getEntranceHeaderRequired()`(`DOCMOST_ENTRANCE_HEADER_REQUIRED`,預設 `false`):header 缺席時,未要求則退回純 CIDR(向下相容單入口部署);已要求則視為 unknown zone(防止繞過 Caddy 直打 docmost)。`.env.example` 已補上這兩個變數與說明註解。
- ✅ P8.3 deploy 文件更新: `DEPLOY_DOCKER.md` 新增「網段來源權限的雙入口」章節,說明預設無感、真正啟用網路隔離的四個步驟、真域名部署的替代寫法;`.env.attach.example`/`.env.integrated.example` 都補上 `OFFICE_HTTP_PORT`/`OFFICE_ENTRANCE_PORT`。
- ✅ P8.4 (新增) unit tests: `network-origin.service.spec.ts` 新增 5 個案例涵蓋「無 header 退回 CIDR」「header 缺席但必填→unknown」「header 與 CIDR 一致」「不一致取較嚴格(雙方向)」「header 值不合法時忽略」,共 16 tests 全過。

## Phase 9 - MrDoc 存量標記(G5，v2 新增)

- ✅ P9.1 一次性回填 SQL(idempotent): `sql/backfill_origin_mrdoc.sql` 靠 `mig_attachment_map`/`mig_image_map`/`mig_page_map` 圈定，`origin_network_scope IS NULL → 'mrdoc'`；包裝腳本 `backfill-origin.sh`。
- ✅ P9.2 `sql/02_migrate_metadata.sql` INSERT attachments(含圖片)/pages 時直接寫 `origin_network_scope='mrdoc'` + `origin_recorded_at`；`ON CONFLICT DO UPDATE` 不覆寫既有 scope。
- ✅ P9.3 重分類 SQL 範本: `sql/reclassify_origin.sql`(按 space/上傳者/時間區間/UUID 清單，人工複製條件執行；admin UI 不在本版範圍)。
- ✅ P9.4 `verify-attachments.sh` 新增第 7 項 scope 統計(遷移附件總數/已標 mrdoc/仍為 NULL);欄位未 migrate 時自動略過。
