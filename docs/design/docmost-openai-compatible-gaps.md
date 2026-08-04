# OpenAI-Compatible 設定 — 未完成 / 未設計盤點

> 對照基準：open-notebook Settings → API Keys（`api/routers/credentials.py`、
> `api/credentials_service.py`、`frontend/.../settings/api-keys/page.tsx`）。
> docmost 現況基準：E9 已落地部分（working tree，見
> [docmost-ai-provider-ui-design.md](./docmost-ai-provider-ui-design.md)、
> [manuals/E9](../manuals/E9-ai-provider-settings.md)）。
> 重新設計方案：[docmost-openai-compatible-redesign.md](./docmost-openai-compatible-redesign.md)。

## 1. 已完成（E9 基礎，毋須重做）

| 項目 | 位置 |
|---|---|
| workspace 級 provider 設定（`settings.ai.provider`，per-field 覆蓋 env） | `ai-provider.service.ts` `resolveConfig()` |
| 4 driver SDK 工廠（openai / openai-compatible / google-ai / ollama） | 同上 `completionModel()` / `embeddingModel()` |
| `POST /api/ai/settings`（admin CASL 閘）+ masked `GET /api/ai/config`（`hasApiKey`，永不回傳 key） | `ai.controller.ts` |
| jsonb merge 寫入 | `workspace.repo.ts` `updateAiProvider()` |
| 前端設定卡（driver/baseUrl/key/models/dimension + Connected badge） | `ai-provider-settings.tsx` |
| resolver 單元測試 6 例（AI 套件 37 例綠） | `ai-provider.service.spec.ts` |

## 2. 未完成（設計已有、實作缺）→ 本輪實作

| # | 缺口 | open-notebook 對應 | docmost 現況 | 處置 |
|---|---|---|---|---|
| G1 | **連線測試**：儲存前無從驗證，第一個錯誤出現在編輯器 Ask AI | `POST /credentials/{id}/test`（1-token 呼叫 + 401/404 錯誤映射） | 無；E9 manual §5 列為 future | `POST /api/ai/settings/test`（draft 合併測試、completion/embedding 分項回報、含 embedding 維度驗證） |
| G2 | **模型探索**：completion/embedding 模型須手打字串 | `POST /credentials/{id}/discover`（`GET /models` → 勾選註冊 + 自訂名 fallback） | 無 | `POST /api/ai/settings/models` → 前端 Autocomplete 建議（保留自由輸入） |
| G3 | **URL 正規化**：尾斜線、誤貼 `/models`、漏 `/v1` 無處理 | `models_endpoint()` 容錯 + probe 建議 | 原字串直接存 | `normalizeBaseUrl()` 統一用於 save/test/discover；`/v1` fallback 以 `normalizedBaseUrl` 建議、不自動改寫 |
| G4 | **apiKey 靜態加密**：jsonb 明文存放 | Fernet（`OPEN_NOTEBOOK_ENCRYPTION_KEY`），遺失金鑰有 decryption_error UX | E9 design §3.4 列為 P3 | AES-256-GCM keyed by `APP_SECRET`（`enc:v1:` 前綴；舊明文 lazy upgrade；解密失敗降級為未設定） |
| G5 | **清除欄位語義**：`""` 行為靠 `\|\|` 巧合；儲存的 key 無法移除 | credential 可整筆刪除 | blank apiKey = keep，無清除途徑 | `""` = 刪除該 override（回落 env）；新增 `clearApiKey: true` 刪除密鑰 |
| G6 | **前端互動**：無測試按鈕、無模型下拉、無 URL 提示 | Test 插頭 / Models 探索 / per-credential 結果 | 純表單 + Save | Fetch models / Test connection 按鈕 + 分項結果列 + normalize 提示（設計書 §4 wireframe） |
| G7 | **🔴 apiKey 洩漏（安全漏洞）**：回傳整個 `settings` jsonb 的端點把 `settings.ai.provider.apiKey` 明文流向**所有登入使用者**。完整掃描找到**四個出口**：`POST /users/me`（最大——每次 app 載入都打）、`POST /auth/setup`、`POST /workspace/info`、`POST /workspace/update` | API「NEVER returns actual API key values」是 router 層硬規則 | E9 design §3.4 有寫「workspace reads must strip it」但未實作 | 共用 `stripWorkspaceSecrets()`（`common/helpers/workspace-secrets.ts`）套用四個出口；G4 加密為第二道防線（即使漏掉出口也只見 `enc:v1:` blob） |

## 3. 未設計（刻意不做，附理由）

| 項目 | open-notebook 有 | 不採用理由 |
|---|---|---|
| 多 credential / provider 多組設定 | credential 表 + migrate/cascade | docmost 每 workspace 單一 provider 設定 + env fallback 已覆蓋需求；多組會引入 model→credential 連結表與遷移 UX，無現行消費者 |
| 模型註冊表（model 表 + default 指派 UI） | register-models + Default Models 區 | docmost 只有 completion/embedding 兩個 slot，直接存字串即可 |
| per-modality endpoint 覆蓋（`endpoint_llm/embedding/stt/tts`） | schema 有（UI 也沒接） | 無 STT/TTS 功能面；jsonb 結構保留擴充空間，等真實拆端點部署需求出現再加 |
| env→DB 遷移精靈（MigrationBanner / migrate-from-env） | 有 | docmost 的 env 本來就是合法常駐來源（per-field merge），不存在「搬家」需求 |
| 加密金鑰獨立於 APP_SECRET（docker secret） | `OPEN_NOTEBOOK_ENCRYPTION_KEY_FILE` | `APP_SECRET` 已是 docmost 既有密鑰管理慣例；獨立金鑰增加部署面負擔。輪替 APP_SECRET → key 降級為未設定（可重填），可接受 |

## 4. 後續

- ✅ Live 驗證（2026-06-12）：fresh dev stack（port 3011）對真實 vLLM 端點
  （`hostip:30015/v1`，qwen3.6-27b-fp8）完成 API 11 項檢查 + Playwright UI 全流程
  （Fetch models → `/v1` 建議套用 → Test connection 綠勾 419ms → Save）。
  紀錄見 [manuals/E9 §4](../manuals/E9-ai-provider-settings.md)。
  未覆蓋：非 admin 403（需第二帳號；同 `assertAdmin` 路徑已有單元覆蓋）、embedding 實測
  （該 vLLM 無 embedding 模型；維度不符路徑有單元測試）。
- ✅ workspace 回應剝除 apiKey 的回歸測試（`workspace.service.spec.ts`）。
- ⬜ i18n：新 UI 字串的翻譯檔補齊（現有卡片字串亦未進翻譯檔，一併處理時再做；
  i18next 缺 key 時 fallback 顯示英文，功能不受影響）。
