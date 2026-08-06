# Docmost AI 對話 — 勾選「使用外部知識庫」 — Design

> 日期：2026-08-03
> 範圍：**docmost**（`integrations/ai/chat` + `ee/ai-chat`），單一 repo
> 姊妹文件：[kb-stack 後台監控與比較](../../../kb-stack/docs/plans/2026-08-03-admin-monitoring-and-compare-design.md)、[OVERLAP_ANALYSIS.md](../../../kb-stack/docs/OVERLAP_ANALYSIS.md) §6

---

## 0. 一句話

在 AI 對話輸入框加一個開關，讓使用者**這一輪要不要查外部知識庫**（Cognee／kb-stack）。
預設開啟（維持現況），關掉可換取速度。

**這是一個「只會縮小」的開關** —— 它移除工具，永遠不會啟用一個未啟用的連接器，
也不會擴大任何資料範圍。因此不新增任何授權面。

---

## 1. 現況

### 1.1 外部知識庫目前是「永遠可用的工具」

`apps/server/src/integrations/ai/chat/ai-chat.service.ts:325`：

```ts
const connectors = this.aiKbService
  .getConnectors(workspace.settings as any)
  .filter((kb) => kb.enabled);
for (const connector of connectors) {
  const toolName = `search_${connector.name…}`;
  tools[toolName] = tool({ … });
}
```

每個**已啟用**的連接器變成一個工具，模型自行決定要不要呼叫。
使用者沒有任何介入手段。

其中 K4.1 的權限範圍（`connector.sync && type === 'cognee'` 時，
把使用者所屬 space 換算成 datasets 傳給 kb-stack）是**權限邊界，本設計完全不動**。

### 1.2 這個模組是本專案自建的，不是上游程式碼

[OVERLAP_ANALYSIS.md §1](../../../kb-stack/docs/OVERLAP_ANALYSIS.md) 已用三項獨立證據確認：

```bash
git ls-tree -r --name-only upstream/main   | grep -c "integrations/ai/"   # → 0
git ls-tree -r --name-only opensource      | grep -c "integrations/ai/"   # → 0
git log --format="%an" -- apps/server/src/integrations/ai/ | sort | uniq -c
#   25 skillagent
```

**所以「不改 Docmost 核心」這條原則在 AI 這一塊不適用** ——
`integrations/ai/`（server）與 `ee/ai*/`（client）本來就是本專案的 25 個 commit。
本設計不增加任何 upstream 合併衝突面。

### 1.3 輸入框已有的結構

`apps/client/src/ee/ai-chat/components/chat-input.tsx`（424 行）底部 `classes.actions`：

```
[＋ Popover 選單]  ←── flex:1 的空白 ──→  [送出 / 停止]
```

`＋` 選單裡已有「Add files」與「Mention a page」。
**開關要放在 `＋` 右側、空白左側** —— 與輸入內容有關的控制項集中在左，
送出動作在右。

送出路徑：`sendChatMessage(params, …)` → `POST /api/ai/chats/send`（SSE 串流），
`params` 對應 `SendChatDto`。

---

## 2. 決策紀錄

| # | 決策 | 理由 |
|---|---|---|
| K1 | 一個布林 `useKnowledgeBase`，**預設 `true`** | 預設 `false` 會讓既有使用者的答案品質**靜默下降**，而他們不知道為什麼。維持現況、讓人主動關掉才是安全的遷移 |
| K2 | 開關是**每則訊息**的參數，不落庫 | 伺服器每輪都重建 tools，本來就無狀態。落庫要 migration，換來的東西很少 |
| K3 | 客戶端把上次選擇記在 `localStorage`，**不是每個對話各自記** | 這是使用者的偏好（「我這台機器上通常要不要查 KB」），不是對話的屬性 |
| K4 | 伺服器端只做**過濾**，不做啟用 | 旗標套在 `.filter(kb => kb.enabled)` **之後**。客戶端永遠不可能靠這個旗標打開任何東西 |
| K5 | **不影響 Docmost 自己的 wiki 檢索** | 那是另一套索引（`ai-answer.service` 的 pgvector），與外部連接器無關。見 §3.3 的文案陷阱 |
| K6 | 沒有任何已啟用的連接器時，**整個開關不渲染** | 一個按了沒反應的開關比沒有開關更糟 |
| K7 | 連接器清單走 `GET /ai/config`，不用 `GET /ai/kb` | `/ai/kb` 回 `maskConnectors`，含 `baseUrl`。對話只需要 `{id, name}`，不該為了一個開關擴大暴露面。見 §6 |
| K8 | **不做**每連接器的個別勾選 | YAGNI。目前部署只有一個連接器（kb-stack 的 shim）。DTO 形狀預留了擴充空間，見 §7 |

---

## 3. 使用者介面

### 3.1 位置與形態

`classes.actions` 裡，`＋` 按鈕右邊加一顆 **chip 型切換鈕**：

```
[＋]  [◆ 知識庫]      ←── flex:1 ──→      [↑]
       ^^^^^^^^^^
       開 = 實心強調色；關 = 灰階外框
```

沿用既有的 `plusButton` 樣式基礎（同樣的高度與圓角），加上
`aria-pressed` 表達開關狀態。滑過顯示 `Tooltip` 說明（§3.3）。

Mantine 的 `Tooltip` 與 `Popover` 在此檔已經 import，不新增相依。

### 3.2 狀態來源

```
GET /ai/config → { …, knowledgeBases: [{id, name}] }   ← 只含已啟用的
                    │
        長度 = 0 ──▶ 不渲染開關（K6）
        長度 ≥ 1 ──▶ 渲染，初始值取 localStorage('ai-chat-use-kb') ?? true
```

送出時併入既有 params：

```ts
sendChatMessage({
  chatId, content, mentionedPageIds, contextPageId, attachmentIds,
  useKnowledgeBase,           // ← 新增
}, …)
```

### 3.3 ★ 文案陷阱：一定要叫「外部知識庫」

Docmost 內有**兩套檢索**：

| | 是什麼 | 這個開關管不管 |
|---|---|---|
| ① wiki 自有索引 | `ai-answer.service` 的 pgvector，搜 Docmost 自己的頁面 | **不管** |
| ② 外部知識庫連接器 | Cognee / kb-stack / custom | **管** |

如果開關只寫「知識庫」，使用者關掉之後會以為「AI 再也搜不到 wiki 了」——
但其實 ① 還在跑。這會製造一整類無法重現的客訴。

所以：

- 標籤：**「外部知識庫」**（en: `External knowledge base`）
- Tooltip 開啟時：「查詢外部知識庫（{{names}}）。關閉可加快回應。」
- Tooltip 關閉時：「已關閉外部知識庫。**Wiki 內容搜尋不受影響。**」

第二句是這個功能最重要的一行文字。

### 3.4 使用者怎麼知道 KB 有沒有被用到

**不需要新東西** —— `chat-tool-group.tsx` 已經會顯示這一輪呼叫了哪些工具。
`search_*` 出現就代表 KB 被查了；沒出現代表模型判斷用不上（即使開關是開的）。

這一點要寫進 Tooltip：**開關是「允許」不是「強制」**，模型仍可能不呼叫它。
否則會有人回報「我開了但它沒查」。

---

## 4. 伺服器端

### 4.1 DTO

`apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts` 的 `SendChatDto` 加一欄：

```ts
@IsOptional()
@IsBoolean()
useKnowledgeBase?: boolean;   // 預設 true（未提供 = 維持現況）
```

`class-validator` 的 `IsBoolean` 需 import。**不加 `@Transform`** ——
客戶端送的是 JSON true/false，不是字串。

### 4.2 `buildTools` 的改動

目前簽章（`ai-chat.service.ts:289`，呼叫點在 `:195`）：

```ts
private buildTools(user, workspace, cfg)
```

改為多收 `dto`：

```ts
private buildTools(user, workspace, cfg, dto: SendChatDto)
```

外部連接器那一段（`:325`）改成：

```ts
// 使用者可以在對話輸入框關閉外部知識庫（速度換品質）。
// ★ 這個旗標只會「移除」工具 —— 它套在 enabled 過濾之後，
//   所以永遠不可能靠它啟用一個未啟用的連接器，也不會擴大 K4.1 的 dataset 範圍。
const useKb = dto.useKnowledgeBase !== false;   // 未提供 = 開啟（K1）
const connectors = useKb
  ? this.aiKbService.getConnectors(workspace.settings as any).filter((kb) => kb.enabled)
  : [];
```

`useKnowledgeBase !== false` 而不是 `=== true`：`undefined` 必須等於開啟，
否則舊版客戶端（或任何不帶這個欄位的呼叫者）會靜默失去 KB。

**其餘一行不改** —— 包括 K4.1 的 `spaceIds → datasets` 範圍計算、
15 秒逾時、失敗回空結果不中斷對話。

### 4.3 `GET /ai/config` 加最小欄位（K7）

`ai.controller.ts:62` 的 `config()` 目前回
`{configured, availableActions, provider}`，且**只有 `JwtAuthGuard`、沒有 admin 檢查**
—— 一般成員拿得到，正是這個開關需要的。

加一欄，**只含 id 與 name**：

```ts
knowledgeBases: this.aiKbService
  .getConnectors(workspace.settings as any)
  .filter((kb) => kb.enabled)
  .map((kb) => ({ id: kb.id, name: kb.name })),
```

不回 `baseUrl`、不回 `type`、不回 `hasApiKey` —— 對話介面只需要
「有沒有」與「叫什麼」（給 Tooltip 用）。

> **順帶記錄的既有現象（本設計不改）**：`GET /ai/kb`（`ai.controller.ts:149`）
> 沒有 `assertAdmin`，任何工作區成員都能拿到 `maskConnectors` 的結果，其中
> **含 `baseUrl`**（`apiKey` 有遮蔽）。這是既有行為、不是本設計造成的，
> 但正因如此，本設計刻意不去依賴它。是否要為 `/ai/kb` 補上 admin 檢查，
> 是一個獨立的決定。

---

## 5. 檔案清單

| 檔案 | 動作 |
|---|---|
| `apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts` | `SendChatDto` 加 `useKnowledgeBase` |
| `apps/server/src/integrations/ai/chat/ai-chat.service.ts` | `buildTools` 多收 `dto`；`:325` 的 connectors 加條件 |
| `apps/server/src/integrations/ai/ai.controller.ts` | `config()` 加 `knowledgeBases` |
| `apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts` | 新測試（§6.1） |
| `apps/client/src/ee/ai/types/ai.types.ts` | config 回應型別加 `knowledgeBases` |
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts` | `sendChatMessage` params 加欄位 |
| `apps/client/src/ee/ai-chat/components/chat-input.tsx` | 開關 UI + localStorage |
| `apps/client/src/ee/ai-chat/pages/ai-chat.tsx` | 把值透傳給 `sendChatMessage`（視現有 props 串接方式） |
| i18n 語言檔 | 三段文案（§3.3） |

**沒有資料庫 migration。**

---

## 6. 測試

### 6.1 伺服器（jest，`ai-chat.service.spec.ts` 已存在）

| 案例 | 期望 |
|---|---|
| `useKnowledgeBase: false` | tools 裡**沒有任何** `search_*` 連接器工具 |
| `useKnowledgeBase: true` | 已啟用的連接器都有對應工具 |
| **欄位未提供** | 與 `true` 相同（K1 的相容性保證，**這是最重要的一條**） |
| 連接器 `enabled: false` + 旗標 `true` | 仍然沒有該工具（K4：旗標不能啟用任何東西） |
| 旗標 `false` | wiki 自有檢索工具**仍存在**（K5） |

```bash
cd apps/server && npx jest src/integrations/ai/chat/ai-chat.service.spec.ts
```

### 6.2 客戶端（vitest）

| 案例 | 期望 |
|---|---|
| `knowledgeBases: []` | 開關不渲染（K6） |
| `knowledgeBases` 有值 | 渲染，預設為開 |
| 點擊後重新掛載 | 從 localStorage 還原關閉狀態 |

```bash
cd apps/client && npx vitest run src/ee/ai-chat/components/chat-input.test.tsx
```

### 6.3 型別與 lint

```bash
npx tsc --noEmit -p apps/server/tsconfig.json      # 從 docmost/ 根目錄
cd apps/server && npx eslint "src/integrations/ai/**/*.ts" --fix
cd apps/client && npx eslint src/ee/ai-chat src/ee/ai
```

⚠ `tsc --noEmit` 目前有 **2 個既有錯誤**在
`collaboration/extensions/redis-sync/*`（已用 `git stash` 確認與功能改動無關）。
**不要把那兩個當成自己造成的**，但也不要新增第三個。

---

## 7. 手動驗證

前置：Docmost 的「設定 → AI → 知識庫」已建好一個 **type=cognee、sync=開啟、
baseUrl 指向 kb-stack `/kb/shim`** 的連接器（三個選擇都不可改，理由見 kb-stack README）。

| # | 步驟 | 期望 |
|---|---|---|
| K-1 | 開關為**開**，問一個只有 wiki 內容答得出的問題 | 答得出；工具列出現 `search_*` |
| K-2 | 關掉開關，問同一題 | 工具列**沒有** `search_*`；回應明顯更快 |
| K-3 | 關掉開關，問一個 wiki 自有索引搜得到的問題 | **仍然搜得到**（K5 —— 這條驗證文案沒有騙人） |
| K-4 | 重整頁面 | 開關維持關閉（localStorage） |
| K-5 | 到設定把連接器停用，回到對話 | 開關**消失**（K6） |
| K-6 | 用舊版前端（或 curl 不帶該欄位）呼叫 `/ai/chats/send` | KB 仍被查詢（K1 相容性） |

K-3 與 K-6 是最容易被實作壞掉、且壞掉後最難察覺的兩項。

---

## 8. 明確不做

- **每個連接器個別勾選** —— 目前只有一個連接器。DTO 之後可加
  `kbConnectorIds?: string[]`，語意為「在 `useKnowledgeBase` 為真時再縮小」，
  不影響現有欄位。
- **把選擇存進對話紀錄** —— 需要 migration，而工具呼叫顯示已經揭露了實際行為（§3.4）。
- **強制模型呼叫 KB** —— 開關是「允許」不是「強制」。要強制得改提示詞策略，
  是另一件事。
- **管理員層級的預設值設定** —— 先看使用者實際上怎麼用。

---

## 9. 風險

| 風險 | 影響 | 緩解 |
|---|---|---|
| 使用者以為關掉 = wiki 搜不到 | 一整類無法重現的客訴 | §3.3 的文案；K-3 手動驗證 |
| 舊客戶端不帶欄位 → 靜默失去 KB | 答案品質下降且無人察覺 | `!== false` 而非 `=== true`；6.1 的「欄位未提供」測試 |
| 使用者開了但模型沒呼叫 | 被當成 bug 回報 | Tooltip 說明「允許不等於強制」；工具呼叫顯示可自證 |
| `/ai/config` 回應變大 | 可忽略（只有 id + name） | 只回已啟用的連接器 |
