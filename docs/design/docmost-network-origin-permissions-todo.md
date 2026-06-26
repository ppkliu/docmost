# Docmost 網段來源權限 Todo

狀態: draft
設計書: [docmost-network-origin-permissions-design.md](./docmost-network-origin-permissions-design.md)
最後更新: 2026-06-25

Legend: ✅ done · 🟡 in progress/partial · ⬜ todo · ⚠ blocked/decision needed

## 設計修改記錄

- 2026-06-25: 建立專用設計書與專用 todo。初版決策: 網段權限只作為既有權限後的二次限制；100 網段放行所有既有權限允許的敏感輸出動作；非 100 網段資源只允許同原網段 download/export/printPDF。
- 2026-06-25: 初版建議舊資料 `origin_network` 為 null 時預設 allow，避免升級後破壞既有下載；高安全部署可改成 deny 並批次回填。
- 2026-06-25: 後端第一版完成: DB 欄位、`NetworkOriginService`、page create/duplicate 來源記錄、attachment/chat attachment upload 來源記錄、attachment private/public download 限制、page/space export 限制；server `tsc --noEmit` 與 service unit tests 通過。

## 目前狀態

- ✅ 已盤點主要後端落點: page create/update、attachment upload/download/info、page/space export、PDF render/printPDF。
- ✅ 已確認現有權限前提: page/attachment 目前依 `PageAccessService` 與 space CASL 控制；新功能不可替代這些檢查。
- ✅ 已實作 DB migration。
- ✅ 已實作 `NetworkOriginService` / `NetworkOriginPolicy` 後端核心。
- 🟡 已接入主要 controller/service: page create/duplicate、attachment upload/download、page/space export；PDF 專用 endpoint 與前端 UX 尚未接。
- 🟡 已補核心 service unit tests；controller/export 整合測試與 live 驗證尚未補。
- ⚠ 需確認「100 網段」與「原網段」CIDR 粒度的部署值。

## Phase 0 - 決策確認

- 🟡 P0.1 先以可配置預設實作: `DOCMOST_INTERNAL_CIDRS=100.0.0.0/8`；仍待業務確認實際內網 CIDR。
- 🟡 P0.2 先以可配置預設實作: IPv4 `/24`、IPv6 `/64`；仍待業務確認粒度。
- 🟡 P0.3 先以可配置預設實作: `DOCMOST_UNKNOWN_ORIGIN_POLICY=allow`；高安全部署可改 `deny`。
- ✅ P0.4 第一版採整包拒絕: space/page export 遇到任一不允許 page/attachment 即 403。
- ✅ P0.5 chat attachment 已納入同一下載限制；新 chat attachment 上傳時也記錄來源網段。

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

## Phase 3 - 寫入來源

- ✅ P3.1 `POST /pages/create` 寫入 page 來源欄位。
- 🟡 P3.2 duplicate 已寫入當前請求來源；import / bulk import 目前無 request origin 接線，保留 null 並走 unknown-origin 策略。
- ✅ P3.3 `POST /files/upload` 新 attachment 寫入來源欄位；`POST /ai/chats/upload` 新 chat attachment 也寫入來源欄位。
- ✅ P3.4 attachment overwrite 不改寫既有來源欄位。
- ⬜ P3.5 migration import 工具如直接寫 DB，需補來源欄位策略或保留 null。

## Phase 4 - 敏感動作限制

- ✅ P4.1 `GET /files/:fileId/:fileName` 加入 attachment download 網段檢查。
- ✅ P4.2 `GET /files/public/:fileId/:fileName` 加入 public attachment download 網段檢查。
- ✅ P4.3 `POST /pages/export` root page 加入 export 網段檢查。
- ✅ P4.4 `POST /pages/export` includeChildren 時檢查所有納入 page。
- ✅ P4.5 `POST /pages/export` includeAttachments 時檢查所有附件。
- ✅ P4.6 `POST /spaces/export` 檢查所有 page 與附件。
- ⬜ P4.7 PDF render / printPDF endpoint 存在時加入 page print 網段檢查。
- ✅ P4.8 保證 100 網段只放行新網段層，不跳過原本 user/page/space 權限。

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

- 🟡 P7.1 server unit tests 通過: `network-origin.service.spec.ts` 6 tests passed；尚未補 controller/export 整合測試。
- ⬜ P7.2 client typecheck 通過。
- ⬜ P7.3 live: 100 網段 request 有原權限時 download/export/printPDF 成功。
- ⬜ P7.4 live: 非 100 同原網段成功。
- ⬜ P7.5 live: 非 100 跨網段被拒絕。
- ⬜ P7.6 live: 無原權限但來自 100 網段仍被拒絕。
