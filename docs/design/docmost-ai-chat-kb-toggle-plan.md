# Docmost AI 對話「使用外部知識庫」勾選 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 對話輸入框加一個開關，讓使用者決定這一輪要不要查外部知識庫（Cognee／kb-stack）。預設開啟（維持現況），關掉可換取速度。

**Architecture:** 伺服器端在 `SendChatDto` 加一個布林，`buildTools()` 據以**過濾**外部連接器工具 —— 旗標套在既有的 `.filter(kb => kb.enabled)` **之後**，所以它只會移除工具，永遠不可能啟用任何東西，不新增授權面。客戶端把選擇存在 localStorage，透過一支共用的偏好模組讓 `ChatInput`（寫）與 `use-chat-stream`（讀）共用，**不做 prop 串接** —— `ChatInput` 有四個消費端，串接會全部要改。

**Tech Stack:** NestJS + Fastify（server）、React + Mantine + TipTap（client）、jest（server 測試）、vitest（client 測試）、TypeScript。

設計依據：[docmost-ai-chat-kb-toggle-design.md](./docmost-ai-chat-kb-toggle-design.md)

## Global Constraints

- **這個模組是本專案自建的，不是上游程式碼。** `integrations/ai/`（server）與 `ee/ai*/`（client）共 25 個 commit 全部出自本專案（三項獨立證據見 [OVERLAP_ANALYSIS.md §1](../../../kb-stack/docs/OVERLAP_ANALYSIS.md)）。所以「不改 Docmost 核心」的原則在這一塊不適用，本計畫也不增加任何 upstream 合併衝突面。
- **零資料庫 migration。** 開關是每則訊息的參數，不落庫。
- **零新增 npm 相依。** Mantine 的 `Tooltip` 在 `chat-input.tsx` 已 import；`Popover`、`IconPlus` 等亦然。
- **判斷式必須是 `!== false`，不可以是 `=== true`。** 欄位未提供時必須等於「開啟」，否則舊版前端會**靜默失去知識庫**。這是本計畫最重要的單一約束。
- **標籤一律寫「外部知識庫」**，不可只寫「知識庫」。理由見 Task 5。
- 驗證：`npx tsc --noEmit -p apps/server/tsconfig.json`（從 `docmost/` 根目錄）、`npx eslint`、`npx jest`（`apps/server` 內）、`npx vitest run`（`apps/client` 內）。
- ⚠ **`tsc --noEmit` 目前有 2 個既有錯誤**在 `collaboration/extensions/redis-sync/*`（已用 `git stash` 確認與功能改動無關）。**不要把那兩個當成自己造成的**，但也**不可新增第三個**。
- **commit 訊息格式 `type: message`，全英文**，type 限 `feat|fix|docs|style|refactor|perf|test|chore|revert`。程式碼、測試、文件**分開 commit**。
- **絕不在 `AgentWiki/` 根目錄執行 `git add`** —— 所有 commit 在 `docmost/` 內執行。
- **檔案不刪除** —— 要移除的移到 `docmost/bak/`。

---

## File Structure

### Server

| 檔案 | 責任 | 動作 |
|---|---|---|
| `apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts` | `SendChatDto` 加 `useKnowledgeBase?: boolean` | 修改 |
| `apps/server/src/integrations/ai/chat/ai-chat.service.ts` | `buildTools` 多收 `dto`；連接器清單加條件 | 修改 |
| `apps/server/src/integrations/ai/ai.controller.ts` | `config()` 加 `knowledgeBases: [{id, name}]` | 修改 |
| `apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts` | 五個新案例 | 修改 |

### Client

| 檔案 | 責任 | 動作 |
|---|---|---|
| `apps/client/src/ee/ai-chat/utils/kb-preference.ts` | **localStorage 偏好的單一來源**（讀／寫） | 新增 |
| `apps/client/src/ee/ai-chat/utils/kb-preference.test.ts` | 偏好模組 | 新增 |
| `apps/client/src/ee/ai/types/ai.types.ts` | `AiConfigResponse` 加 `knowledgeBases?` | 修改 |
| `apps/client/src/ee/ai/queries/ai-query.ts` | 加 `useAiConfigQuery`（目前只有 service，沒有 hook） | 修改 |
| `apps/client/src/ee/ai-chat/services/ai-chat-service.ts` | `sendChatMessage` params 加欄位 | 修改 |
| `apps/client/src/ee/ai-chat/hooks/use-chat-stream.ts` | 送出時讀偏好併入 params | 修改 |
| `apps/client/src/ee/ai-chat/components/chat-input.tsx` | 開關 UI | 修改 |
| `apps/client/src/ee/ai-chat/components/chat-input.test.tsx` | 開關的顯示條件與狀態 | 新增 |
| i18n 語言檔 | 四段文案 | 修改 |

**為什麼用共用偏好模組而不是 prop 串接**：`ChatInput` 有**四個**消費端（`chat-empty-state.tsx`、`ai-chat-layout.tsx`、`aside-chat-panel.tsx`、`home-ai-prompt.tsx`）。把開關值從 `ChatInput` 一路傳到 `use-chat-stream` 的 `sendMessage` 要改動 `onSend` 的簽章與這四個檔案。而這個值本來就是**裝置層級的使用者偏好**（設計 K3），不是某一則訊息的資料 —— 放在一支雙方都 import 的小模組裡，語意更正確且改動面小得多。

---

## ⚠ 開工前必讀：三個既有事實

1. **`GET /ai/kb`（`ai.controller.ts:149`）沒有 `assertAdmin`** —— 任何工作區成員都拿得到 `maskConnectors` 的結果，其中**含 `baseUrl`**。這是既有行為，**本計畫不修它，也刻意不依賴它**。開關需要的清單改從 `GET /ai/config` 拿（本來就是成員可讀，且只回 `{id, name}`）。
2. **`buildTools` 目前的簽章是 `(user, workspace, cfg)`**，唯一呼叫點在 `ai-chat.service.ts:195`。要多收 `dto`。
3. **`useAiConfigQuery` 不存在** —— `getAiConfig()` 在 `ai-provider-service.ts:11` 有，但 `ai-query.ts` 沒有對應的 hook。Task 4 要補。

---

## Task 1: 伺服器端 —— DTO 與工具過濾

**Files:**
- Modify: `apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts`
- Modify: `apps/server/src/integrations/ai/chat/ai-chat.service.ts:195, 289, 325-330`
- Test: `apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts`

**Interfaces:**
- Consumes: `AiKbService.getConnectors(settings)`（既有）
- Produces:
  - `SendChatDto.useKnowledgeBase?: boolean`
  - `private buildTools(user: User, workspace: Workspace, cfg: ResolvedAiConfig, dto: SendChatDto): ToolSet`

  Task 4 的客戶端送這個欄位。

**★ 這一個 Task 是整個功能的核心，其餘都是把它接出來。**

- [ ] **Step 1: 寫失敗的測試**

在 `apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts` 的 `describe('AiChatService', ...)` 內，加入一個新的 `describe` 區塊（放在既有的 `describe('CRUD', ...)` 之後）：

```ts
  describe('external knowledge base toggle', () => {
    const connectors = [
      { id: 'kb1', name: 'Cognee', type: 'cognee', enabled: true, sync: false },
    ];

    /** 跑一次 sendMessage 並回傳這一輪實際建出來的 tool 名稱。 */
    async function toolNamesFor(dtoExtra: Record<string, unknown>, kbOverrides = {}) {
      const repo = makeRepo({
        insertChat: jest.fn().mockResolvedValue({ id: 'c1', title: 't' }),
        findChatById: jest.fn().mockResolvedValue({ id: 'c1', title: 't' }),
        findMessages: jest.fn().mockResolvedValue([]),
        insertMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      });
      const kb = makeKb({
        getConnectors: jest.fn().mockReturnValue(connectors),
        ...kbOverrides,
      });
      const svc = makeService(repo, makeProvider(), makeAnswer(), makeAttachmentRepo(), kb);
      mockFullStream([{ type: 'text-delta', text: 'hi' }]);

      await drain(
        svc.sendMessage(
          { chatId: 'c1', content: 'q', ...dtoExtra } as any,
          user,
          workspace,
        ),
      );

      const call = (streamText as jest.Mock).mock.calls.at(-1)[0];
      return Object.keys(call.tools ?? {});
    }

    it('offers a search tool per enabled connector when the flag is true', async () => {
      const names = await toolNamesFor({ useKnowledgeBase: true });
      expect(names).toContain('search_cognee');
    });

    it('offers no connector tools when the flag is false', async () => {
      const names = await toolNamesFor({ useKnowledgeBase: false });
      expect(names.filter((n) => n.startsWith('search_cognee'))).toHaveLength(0);
    });

    // ★ 最重要的一條：舊版前端不會送這個欄位。未提供必須等於「開啟」，
    //   否則升級後所有既有客戶端都會靜默失去知識庫，而且沒有人會察覺。
    it('treats an absent flag as enabled (backward compatibility)', async () => {
      const names = await toolNamesFor({});
      expect(names).toContain('search_cognee');
    });

    // 旗標只會「移除」工具。它套在 enabled 過濾之後，所以不可能靠它啟用任何東西。
    it('never enables a disabled connector, even with the flag on', async () => {
      const names = await toolNamesFor(
        { useKnowledgeBase: true },
        { getConnectors: jest.fn().mockReturnValue([{ ...connectors[0], enabled: false }]) },
      );
      expect(names.filter((n) => n.startsWith('search_cognee'))).toHaveLength(0);
    });

    // ★ 這個開關**不管** Docmost 自己的 wiki 檢索（ai-answer 的 pgvector 索引）。
    //   關掉之後 wiki 仍然搜得到 —— 這正是 UI 文案要講清楚的事。
    it('leaves the built-in wiki search tool untouched when the flag is false', async () => {
      const repo = makeRepo({
        findChatById: jest.fn().mockResolvedValue({ id: 'c1', title: 't' }),
        findMessages: jest.fn().mockResolvedValue([]),
        insertMessage: jest.fn().mockResolvedValue({ id: 'm1' }),
      });
      const answer = makeAnswer({ isConfigured: jest.fn().mockReturnValue(true) });
      const kb = makeKb({ getConnectors: jest.fn().mockReturnValue(connectors) });
      const svc = makeService(repo, makeProvider(), answer, makeAttachmentRepo(), kb);
      mockFullStream([{ type: 'text-delta', text: 'hi' }]);

      await drain(
        svc.sendMessage(
          { chatId: 'c1', content: 'q', useKnowledgeBase: false } as any,
          user,
          workspace,
        ),
      );

      const call = (streamText as jest.Mock).mock.calls.at(-1)[0];
      expect(Object.keys(call.tools ?? {})).toContain('search_workspace');
    });
  });
```

- [ ] **Step 2: 執行測試確認失敗**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost/apps/server
npx jest src/integrations/ai/chat/ai-chat.service.spec.ts -t "external knowledge base toggle"
```
Expected: FAIL —— `offers no connector tools when the flag is false` 這一條會失敗（旗標尚未生效，工具仍然被建出來）。

- [ ] **Step 3: 在 DTO 加欄位**

Modify `apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts`：

把頂端的 import 加上 `IsBoolean`：

```ts
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
```

在 `SendChatDto` 的 `attachmentIds` 之後加入：

```ts
  /**
   * Whether this turn may search external knowledge-base connectors
   * (Cognee / kb-stack / custom).
   *
   * Absent means enabled — older clients do not send this field and must not
   * silently lose the knowledge base. Never compare with `=== true`.
   *
   * This flag can only *remove* tools: it is applied after the `enabled`
   * filter, so it can never turn on a connector that is switched off, and it
   * does not touch the per-space dataset scoping (K4.1).
   */
  @IsOptional()
  @IsBoolean()
  useKnowledgeBase?: boolean;
```

- [ ] **Step 4: 讓 `buildTools` 收 dto 並過濾**

Modify `apps/server/src/integrations/ai/chat/ai-chat.service.ts`：

① 呼叫點（第 195 行附近）：

```ts
    const tools = this.buildTools(user, workspace, cfg, dto);
```

② 簽章（第 289 行附近）：

```ts
  private buildTools(
    user: User,
    workspace: Workspace,
    cfg: ResolvedAiConfig,
    dto: SendChatDto,
  ): ToolSet {
```

③ 連接器清單（第 325 行附近），把

```ts
    const connectors = this.aiKbService
      .getConnectors(workspace.settings as any)
      .filter((kb) => kb.enabled);
```

改成

```ts
    // The user can switch external knowledge bases off for a turn to trade
    // answer quality for speed (KB search adds a round-trip, and the KB call
    // has a hard 15s timeout on our side).
    //
    // `!== false` — not `=== true`. An absent field means enabled, so older
    // clients keep working exactly as before instead of silently losing the
    // knowledge base.
    //
    // Applied *after* the `enabled` filter: this flag can only remove tools.
    // It can never enable a switched-off connector, and it does not touch the
    // K4.1 dataset scoping below.
    const useKnowledgeBase = dto.useKnowledgeBase !== false;
    const connectors = useKnowledgeBase
      ? this.aiKbService
          .getConnectors(workspace.settings as any)
          .filter((kb) => kb.enabled)
      : [];
```

**這個 `for` 迴圈以下的內容一行都不要動** —— 包含 `connector.sync && connector.type === 'cognee'` 的 space 範圍計算、15 秒逾時、失敗回空結果不中斷對話。

- [ ] **Step 5: 執行測試確認通過**

Run:
```bash
npx jest src/integrations/ai/chat/ai-chat.service.spec.ts
```
Expected: PASS，含新增的 5 個案例與該檔既有的全部案例。

- [ ] **Step 6: 型別與 lint**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
npx tsc --noEmit -p apps/server/tsconfig.json
```
Expected: **恰好 2 個錯誤**，且都在 `collaboration/extensions/redis-sync/*`（既有問題）。出現第三個就是自己造成的，要修掉。

Run:
```bash
cd apps/server && npx eslint "src/integrations/ai/**/*.ts" --fix
```
Expected: 無錯誤。

- [ ] **Step 7: Commit**

```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
git add apps/server/src/integrations/ai/chat/dto/ai-chat.dto.ts \
        apps/server/src/integrations/ai/chat/ai-chat.service.ts
git commit -m "feat: let users disable external knowledge base per chat turn"
git add apps/server/src/integrations/ai/chat/ai-chat.service.spec.ts
git commit -m "test: cover knowledge base toggle including absent-flag default"
```

---

## Task 2: `/ai/config` 回報可用的連接器

**Files:**
- Modify: `apps/server/src/integrations/ai/ai.controller.ts:62-70`
- Test: `apps/server/src/integrations/ai/ai.controller.spec.ts`（若不存在則新增）

**Interfaces:**
- Consumes: `AiKbService.getConnectors(settings)`
- Produces: `GET /ai/config` 的回應多一欄
  `knowledgeBases: Array<{ id: string; name: string }>` —— **只有已啟用的，且只有這兩個欄位**

  Task 4 的客戶端型別、Task 5 的顯示條件都依賴它。

**★ 為什麼不用既有的 `GET /ai/kb`：** 那支回 `maskConnectors`，含 `baseUrl`。對話介面只需要「有沒有」與「叫什麼」（給 Tooltip 用），不該為了一個開關擴大暴露面。

- [ ] **Step 1: 寫失敗的測試**

若 `apps/server/src/integrations/ai/ai.controller.spec.ts` 不存在，建立它：

```ts
import { AiController } from './ai.controller';

const workspace = {
  id: 'w1',
  settings: {
    ai: {
      knowledgeBases: [
        { id: 'kb1', name: 'Cognee', type: 'cognee', baseUrl: 'http://kb:3000/kb/shim', enabled: true },
        { id: 'kb2', name: 'Legacy', type: 'custom', baseUrl: 'http://old', enabled: false },
      ],
    },
  },
} as any;

function makeController(overrides: Record<string, any> = {}) {
  const provider = {
    resolveConfig: jest.fn().mockReturnValue({ driver: 'openai' }),
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const kb = {
    getConnectors: jest.fn().mockImplementation(
      (s: any) => s?.ai?.knowledgeBases ?? [],
    ),
    maskConnectors: jest.fn().mockReturnValue([]),
  };
  return new AiController(
    { } as any,          // aiService
    provider as any,
    { } as any,          // aiConnectionService
    kb as any,
    { } as any,          // kbSyncService
    { } as any,          // aiIndexingService
    { } as any,          // workspaceRepo
    { } as any,          // workspaceAbility
    ...([] as any[]),
  );
}
```

> ⚠ `AiController` 的建構子參數順序以該檔實際的 `constructor(...)` 為準 ——
> 先執行下列指令看清楚再寫，**不要憑上面的順序猜**：
> ```bash
> sed -n '44,60p' apps/server/src/integrations/ai/ai.controller.ts
> ```
> 若參數過多不便手工組裝，改用 NestJS 的 `Test.createTestingModule` 並只提供
> `AiProviderService` 與 `AiKbService` 兩個真正用到的 provider。

接著加入測試本體：

```ts
describe('AiController.config', () => {
  it('returns only enabled connectors, with id and name only', () => {
    const c = makeController();
    const out: any = c.config(workspace);

    expect(out.knowledgeBases).toEqual([{ id: 'kb1', name: 'Cognee' }]);
  });

  it('★ never leaks baseUrl or apiKey to the chat UI', () => {
    const c = makeController();
    const out: any = c.config(workspace);

    const keys = Object.keys(out.knowledgeBases[0]);
    expect(keys.sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(out)).not.toContain('kb:3000');
  });

  it('returns an empty array when no connectors are configured', () => {
    const c = makeController();
    const out: any = c.config({ id: 'w1', settings: {} } as any);
    expect(out.knowledgeBases).toEqual([]);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run:
```bash
cd apps/server
npx jest src/integrations/ai/ai.controller.spec.ts
```
Expected: FAIL —— `out.knowledgeBases` 是 `undefined`。

- [ ] **Step 3: 寫實作**

Modify `apps/server/src/integrations/ai/ai.controller.ts` 的 `config()`：

```ts
  @HttpCode(HttpStatus.OK)
  @Get('config')
  config(@AuthWorkspace() workspace: Workspace) {
    const cfg = this.aiProviderService.resolveConfig(workspace.settings as any);
    return {
      configured: this.aiProviderService.isConfigured(cfg) && this.isEnabled(workspace),
      availableActions: AI_ACTION_IDS,
      provider: this.maskedProvider(cfg),
      // Minimal connector info for the chat input's knowledge-base toggle:
      // does one exist, and what is it called (for the tooltip).
      //
      // Deliberately NOT reusing GET /ai/kb — that returns maskConnectors(),
      // which includes baseUrl. The chat UI needs neither the URL nor the type,
      // and this endpoint is reachable by every workspace member.
      knowledgeBases: this.aiKbService
        .getConnectors(workspace.settings as any)
        .filter((kb) => kb.enabled)
        .map((kb) => ({ id: kb.id, name: kb.name })),
    };
  }
```

- [ ] **Step 4: 執行測試確認通過**

Run:
```bash
npx jest src/integrations/ai/ai.controller.spec.ts
```
Expected: PASS，3 個案例全過。

- [ ] **Step 5: 型別與 lint**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
npx tsc --noEmit -p apps/server/tsconfig.json
cd apps/server && npx eslint "src/integrations/ai/**/*.ts" --fix
```
Expected: `tsc` 恰好 2 個既有錯誤；eslint 無錯誤。

- [ ] **Step 6: Commit**

```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
git add apps/server/src/integrations/ai/ai.controller.ts
git commit -m "feat: expose enabled knowledge base names on ai config"
git add apps/server/src/integrations/ai/ai.controller.spec.ts
git commit -m "test: verify ai config exposes only connector id and name"
```

---

## Task 3: 客戶端偏好模組（單一來源）

**Files:**
- Create: `apps/client/src/ee/ai-chat/utils/kb-preference.ts`
- Test: `apps/client/src/ee/ai-chat/utils/kb-preference.test.ts`

**Interfaces:**
- Consumes: `window.localStorage`
- Produces:
  - `KB_PREFERENCE_KEY = 'ai-chat-use-kb'`
  - `getUseKnowledgeBase(): boolean` —— 預設 `true`；讀取失敗（無痕模式、storage 被封鎖）也回 `true`
  - `setUseKnowledgeBase(value: boolean): void` —— 寫入失敗不拋錯

  Task 4 的 `use-chat-stream` 讀、Task 5 的 `ChatInput` 讀寫。

**★ 為什麼是模組而不是 prop：** `ChatInput` 有四個消費端（`chat-empty-state.tsx`、`ai-chat-layout.tsx`、`aside-chat-panel.tsx`、`home-ai-prompt.tsx`）。串接要動 `onSend` 簽章與這四個檔案，而這個值本來就是裝置層級偏好，不是訊息資料。

- [ ] **Step 1: 寫失敗的測試**

Create `apps/client/src/ee/ai-chat/utils/kb-preference.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  KB_PREFERENCE_KEY,
  getUseKnowledgeBase,
  setUseKnowledgeBase,
} from "./kb-preference";

describe("kb-preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  // ★ 預設必須是「開啟」：改成預設關閉會讓既有使用者的答案品質靜默下降，
  //   而他們不知道為什麼。
  it("defaults to enabled when nothing is stored", () => {
    expect(getUseKnowledgeBase()).toBe(true);
  });

  it("round-trips false and true", () => {
    setUseKnowledgeBase(false);
    expect(getUseKnowledgeBase()).toBe(false);
    setUseKnowledgeBase(true);
    expect(getUseKnowledgeBase()).toBe(true);
  });

  it("stores under a stable key", () => {
    setUseKnowledgeBase(false);
    expect(localStorage.getItem(KB_PREFERENCE_KEY)).toBe("false");
  });

  it("treats a corrupted value as enabled", () => {
    localStorage.setItem(KB_PREFERENCE_KEY, "banana");
    expect(getUseKnowledgeBase()).toBe(true);
  });

  // 無痕模式／storage 被封鎖時 localStorage 會拋錯。開關壞掉不該讓對話送不出去。
  it("survives localStorage throwing on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getUseKnowledgeBase()).toBe(true);
  });

  it("survives localStorage throwing on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => setUseKnowledgeBase(false)).not.toThrow();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost/apps/client
npx vitest run src/ee/ai-chat/utils/kb-preference.test.ts
```
Expected: FAIL —— 找不到 `./kb-preference`。

- [ ] **Step 3: 寫實作**

Create `apps/client/src/ee/ai-chat/utils/kb-preference.ts`：

```ts
/**
 * "Search external knowledge bases" preference for the AI chat input.
 *
 * This is a device-level user preference ("do I usually want the KB on this
 * machine"), not a property of a chat or a message — so it lives here rather
 * than being threaded through props. ChatInput writes it; use-chat-stream
 * reads it at send time. Both import this module, so there is exactly one
 * source of truth.
 *
 * Threading it as a prop instead would mean changing ChatInput's `onSend`
 * signature and all four of its consumers (chat-empty-state, ai-chat-layout,
 * aside-chat-panel, home-ai-prompt) for a value none of them care about.
 */

export const KB_PREFERENCE_KEY = "ai-chat-use-kb";

/**
 * Defaults to `true`.
 *
 * Every failure path also returns `true`: a broken toggle must never silently
 * downgrade answer quality. Users notice a slow answer; they do not notice a
 * worse one.
 */
export function getUseKnowledgeBase(): boolean {
  try {
    return localStorage.getItem(KB_PREFERENCE_KEY) !== "false";
  } catch {
    // Private mode / storage blocked by policy.
    return true;
  }
}

export function setUseKnowledgeBase(value: boolean): void {
  try {
    localStorage.setItem(KB_PREFERENCE_KEY, value ? "true" : "false");
  } catch {
    // Preference is a convenience; failing to persist it must not break send.
  }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run:
```bash
npx vitest run src/ee/ai-chat/utils/kb-preference.test.ts
```
Expected: PASS，6 個案例全過。

- [ ] **Step 5: Commit**

```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
git add apps/client/src/ee/ai-chat/utils/kb-preference.ts
git commit -m "feat: add knowledge base preference storage"
git add apps/client/src/ee/ai-chat/utils/kb-preference.test.ts
git commit -m "test: cover knowledge base preference defaults and failures"
```

---

## Task 4: 客戶端串接（型別、query hook、送出路徑）

**Files:**
- Modify: `apps/client/src/ee/ai/types/ai.types.ts:40-44`
- Modify: `apps/client/src/ee/ai/queries/ai-query.ts`
- Modify: `apps/client/src/ee/ai-chat/services/ai-chat-service.ts:61-70`
- Modify: `apps/client/src/ee/ai-chat/hooks/use-chat-stream.ts:98-106`

**Interfaces:**
- Consumes: `getUseKnowledgeBase()`（Task 3）、`getAiConfig()`（既有，`ai-provider-service.ts:11`）
- Produces:
  - `AiConfigResponse.knowledgeBases?: Array<{ id: string; name: string }>`
  - `useAiConfigQuery(): UseQueryResult<AiConfigResponse, Error>`
  - `sendChatMessage` 的 params 多 `useKnowledgeBase?: boolean`

  Task 5 用 `useAiConfigQuery`。

- [ ] **Step 1: 型別加欄位**

Modify `apps/client/src/ee/ai/types/ai.types.ts`：

```ts
export interface AiConfigResponse {
  configured: boolean;
  availableActions: AiAction[];
  provider?: AiProviderConfig;
  /** Enabled external KB connectors — id and name only (see AiController.config). */
  knowledgeBases?: Array<{ id: string; name: string }>;
}
```

- [ ] **Step 2: 加 query hook**

Modify `apps/client/src/ee/ai/queries/ai-query.ts`：

在 import 區加入：

```ts
import { getAiConfig } from "@/ee/ai/services/ai-provider-service.ts";
```

在檔案末尾加入：

```ts
/**
 * Workspace AI config. Reachable by every member (no admin check), and now
 * also carries the enabled knowledge-base connector names used by the chat
 * input's toggle.
 */
export function useAiConfigQuery(): UseQueryResult<AiConfigResponse, Error> {
  return useQuery({
    queryKey: ["ai-config"],
    queryFn: getAiConfig,
    staleTime: 5 * 60 * 1000,
  });
}
```

- [ ] **Step 3: `sendChatMessage` 接受新欄位**

Modify `apps/client/src/ee/ai-chat/services/ai-chat-service.ts`：

```ts
export function sendChatMessage(
  params: {
    chatId?: string;
    content: string;
    mentionedPageIds?: string[];
    contextPageId?: string;
    attachmentIds?: string[];
    /** Absent means enabled — see kb-preference.ts and SendChatDto. */
    useKnowledgeBase?: boolean;
  },
  onEvent: (event: AiChatStreamEvent) => void,
  onError?: (error: string) => void,
  onComplete?: () => void,
): AbortController {
```

函式本體不需要改（`params` 是整包 `JSON.stringify` 送出的）。

- [ ] **Step 4: 送出時帶上偏好**

Modify `apps/client/src/ee/ai-chat/hooks/use-chat-stream.ts`：

在 import 區加入：

```ts
import { getUseKnowledgeBase } from "../utils/kb-preference";
```

把 `sendChatMessage(...)` 的第一個參數改成：

```ts
      const abortController = sendChatMessage(
        {
          chatId: currentChatIdRef.current,
          content,
          mentionedPageIds: mentions.map((m) => m.id),
          ...(contextPageId && { contextPageId }),
          ...(attachmentIds.length && { attachmentIds }),
          // Read at send time rather than being passed down: this is a device
          // preference, and ChatInput has four consumers that would otherwise
          // all need to thread it through.
          useKnowledgeBase: getUseKnowledgeBase(),
        },
        (event: AiChatStreamEvent) => {
```

- [ ] **Step 5: 型別檢查**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost/apps/client
npx tsc --noEmit -p tsconfig.json
```
Expected: 無新增錯誤。（若此專案沒有獨立的 client tsconfig 檢查指令，改用 `npx vite build --mode development` 或 `npx eslint` 確認 import 正確。）

Run:
```bash
npx eslint src/ee/ai-chat src/ee/ai
```
Expected: 無錯誤。

- [ ] **Step 6: Commit**

```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
git add apps/client/src/ee/ai/types/ai.types.ts \
        apps/client/src/ee/ai/queries/ai-query.ts \
        apps/client/src/ee/ai-chat/services/ai-chat-service.ts \
        apps/client/src/ee/ai-chat/hooks/use-chat-stream.ts
git commit -m "feat: send knowledge base preference with each chat message"
```

---

## Task 5: 輸入框的開關 UI

**Files:**
- Modify: `apps/client/src/ee/ai-chat/components/chat-input.tsx`
- Test: `apps/client/src/ee/ai-chat/components/chat-input.test.tsx`

**Interfaces:**
- Consumes: `getUseKnowledgeBase` / `setUseKnowledgeBase`（Task 3）、`useAiConfigQuery`（Task 4）
- Produces: 一顆 chip 型切換鈕，位置在 `classes.actions` 內、`＋` 按鈕右側、`flex:1` 空白左側

**★ 文案陷阱（設計 §3.3）—— 這是本 Task 最重要的部分：**

Docmost 內有**兩套**檢索：① wiki 自有的 pgvector 索引（`ai-answer.service`），② 外部知識庫連接器。這個開關**只管 ②**。

若標籤只寫「知識庫」，使用者關掉後會以為「AI 再也搜不到 wiki 了」—— 這會製造一整類無法重現的客訴。所以：

- 標籤必須是 **「外部知識庫」**（en: `External knowledge base`）
- 關閉時的 Tooltip 必須明說 **「Wiki 內容搜尋不受影響」**

另外，開關是**「允許」不是「強制」** —— 模型仍可能判斷用不上而不呼叫。這要寫進 Tooltip，否則會有人回報「我開了但它沒查」。（使用者可以自己確認：`chat-tool-group.tsx` 已經會顯示這一輪呼叫了哪些工具。）

- [ ] **Step 1: 寫失敗的測試**

Create `apps/client/src/ee/ai-chat/components/chat-input.test.tsx`：

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ChatInput from "./chat-input";
import { KB_PREFERENCE_KEY } from "../utils/kb-preference";

const mockConfig = vi.fn();
vi.mock("@/ee/ai/queries/ai-query.ts", () => ({
  useAiConfigQuery: () => mockConfig(),
}));

function renderInput() {
  return render(
    <MantineProvider>
      <ChatInput isStreaming={false} onSend={() => {}} onStop={() => {}} />
    </MantineProvider>,
  );
}

describe("ChatInput knowledge base toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    mockConfig.mockReturnValue({
      data: { knowledgeBases: [{ id: "kb1", name: "Cognee" }] },
    });
  });

  // 一個按了沒反應的開關比沒有開關更糟。
  it("is not rendered when no connectors are configured", () => {
    mockConfig.mockReturnValue({ data: { knowledgeBases: [] } });
    renderInput();
    expect(screen.queryByTestId("kb-toggle")).toBeNull();
  });

  it("is not rendered while config is still loading", () => {
    mockConfig.mockReturnValue({ data: undefined });
    renderInput();
    expect(screen.queryByTestId("kb-toggle")).toBeNull();
  });

  it("renders enabled by default", () => {
    renderInput();
    const btn = screen.getByTestId("kb-toggle");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("persists the off state and restores it on remount", () => {
    const { unmount } = renderInput();
    fireEvent.click(screen.getByTestId("kb-toggle"));
    expect(localStorage.getItem(KB_PREFERENCE_KEY)).toBe("false");
    unmount();

    renderInput();
    expect(screen.getByTestId("kb-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  // ★ 使用者若以為關掉會讓 AI 搜不到 wiki，會製造一整類無法重現的客訴。
  it("says wiki search is unaffected when switched off", () => {
    renderInput();
    fireEvent.click(screen.getByTestId("kb-toggle"));
    const label = screen.getByTestId("kb-toggle").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Wiki/i);
  });

  it("labels itself as EXTERNAL knowledge base, not just knowledge base", () => {
    renderInput();
    expect(screen.getByTestId("kb-toggle").textContent ?? "").toMatch(/外部|External/);
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost/apps/client
npx vitest run src/ee/ai-chat/components/chat-input.test.tsx
```
Expected: FAIL —— 找不到 `kb-toggle`。

> 若 `@testing-library/react` 尚未安裝，**不要新增相依**。改為把測試縮減到不需要
> 渲染的部分（開關的顯示條件是純函式的話可以抽出來測），並在 Task 6 的手動驗證
> 補足 UI 行為。先執行 `grep -n "@testing-library" apps/client/package.json` 確認。

- [ ] **Step 3: 加入 import 與狀態**

Modify `apps/client/src/ee/ai-chat/components/chat-input.tsx`：

在既有 import 區加入：

```tsx
import { IconDatabase } from "@tabler/icons-react";
import { Tooltip } from "@mantine/core";
import { useAiConfigQuery } from "@/ee/ai/queries/ai-query.ts";
import { getUseKnowledgeBase, setUseKnowledgeBase } from "../utils/kb-preference";
```

> `IconDatabase` 若該圖示集沒有，改用既有已 import 的任一圖示（例如 `IconAt`
> 旁邊可用的），不要為了圖示新增相依。

在 `const [plusMenuOpen, setPlusMenuOpen] = useState(false);` 之後加入：

```tsx
  // 外部知識庫開關。連接器清單來自 /ai/config（只回 id 與 name）。
  const { data: aiConfig } = useAiConfigQuery();
  const kbConnectors = aiConfig?.knowledgeBases ?? [];
  const [useKb, setUseKb] = useState(getUseKnowledgeBase);
```

- [ ] **Step 4: 加入按鈕**

在 `<div className={classes.actions}>` 內，`</Popover>` 之後、`<div style={{ flex: 1 }} />` **之前**插入：

```tsx
        {kbConnectors.length > 0 && (
          <Tooltip
            multiline
            w={260}
            label={
              useKb
                ? t(
                    "Search the external knowledge base ({{names}}). Turn it off for faster replies. The model may still decide not to use it.",
                    { names: kbConnectors.map((k) => k.name).join(", ") },
                  )
                : t(
                    "External knowledge base is off. Wiki content search is unaffected.",
                  )
            }
          >
            <button
              type="button"
              data-testid="kb-toggle"
              aria-pressed={useKb}
              aria-label={
                useKb
                  ? t("External knowledge base is on")
                  : t(
                      "External knowledge base is off. Wiki content search is unaffected.",
                    )
              }
              className={classes.plusButton}
              style={{
                width: "auto",
                padding: "0 8px",
                gap: 4,
                display: "inline-flex",
                alignItems: "center",
                opacity: useKb ? 1 : 0.55,
              }}
              onClick={() => {
                const next = !useKb;
                setUseKb(next);
                setUseKnowledgeBase(next);
              }}
            >
              <IconDatabase size={14} />
              <span style={{ fontSize: 12 }}>{t("External knowledge base")}</span>
            </button>
          </Tooltip>
        )}
```

- [ ] **Step 5: 執行測試確認通過**

Run:
```bash
npx vitest run src/ee/ai-chat/components/chat-input.test.tsx
```
Expected: PASS，6 個案例全過。

- [ ] **Step 6: lint**

Run:
```bash
npx eslint src/ee/ai-chat
```
Expected: 無錯誤。

- [ ] **Step 7: Commit**

```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
git add apps/client/src/ee/ai-chat/components/chat-input.tsx
git commit -m "feat: add external knowledge base toggle to chat input"
git add apps/client/src/ee/ai-chat/components/chat-input.test.tsx
git commit -m "test: cover knowledge base toggle visibility and copy"
```

---

## Task 6: i18n、手動驗證與文件

**Files:**
- Modify: i18n 語言檔（`apps/client/src/i18n/locales/*.json` 或該專案實際的語言檔位置）
- Modify: `docs/USER-MANUAL.md`

**Interfaces:**
- Consumes: Task 1–5 的全部成果
- Produces: 四段翻譯 + 使用手冊的一段說明

- [ ] **Step 1: 找到語言檔並加入四段文案**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
ls apps/client/src/i18n/locales/ 2>/dev/null || find apps/client/src -name "*.json" -path "*locale*" | head
```

在英文與繁體中文語言檔各加入四個 key（照該檔既有的排序與格式）：

| key | en | zh-TW |
|---|---|---|
| `External knowledge base` | External knowledge base | 外部知識庫 |
| `External knowledge base is on` | External knowledge base is on | 外部知識庫：開啟 |
| `External knowledge base is off. Wiki content search is unaffected.` | External knowledge base is off. Wiki content search is unaffected. | 外部知識庫已關閉。**Wiki 內容搜尋不受影響。** |
| `Search the external knowledge base ({{names}}). Turn it off for faster replies. The model may still decide not to use it.` | Search the external knowledge base ({{names}}). Turn it off for faster replies. The model may still decide not to use it. | 查詢外部知識庫（{{names}}）。關閉可加快回應。模型仍可能判斷用不上而不查詢。 |

第三段的「Wiki 內容搜尋不受影響」是整個功能最重要的一行文字，**不可省略或簡化**。

- [ ] **Step 2: 全套自動驗證**

Run:
```bash
cd /home/image/projllm/llmservice/vermilion/AgentWiki/docmost
npx tsc --noEmit -p apps/server/tsconfig.json
cd apps/server && npx jest src/integrations/ai
cd ../client && npx vitest run src/ee/ai-chat
cd ../server && npx eslint "src/integrations/ai/**/*.ts"
cd ../client && npx eslint src/ee/ai-chat src/ee/ai
```
Expected:
- `tsc`：**恰好 2 個既有錯誤**，都在 `collaboration/extensions/redis-sync/*`
- jest / vitest：全綠
- eslint：兩邊都無錯誤

- [ ] **Step 3: 手動驗證 K-1 ～ K-6**

前置：Docmost 的「設定 → AI → 知識庫」已建好一個 **type=cognee、sync=開啟、baseUrl 指向 kb-stack `/kb/shim`** 的連接器（三個選擇都不可改）。

```bash
pnpm dev    # client + server
```

| # | 步驟 | 期望 |
|---|---|---|
| K-1 | 開關為**開**，問一個只有 wiki 內容答得出的問題 | 答得出；工具列出現 `search_*` |
| K-2 | 關掉開關，問同一題 | 工具列**沒有** `search_*`；回應明顯更快 |
| K-3 | **關掉開關**，問一個 wiki 自有索引搜得到的問題 | **仍然搜得到**（驗證文案沒有騙人） |
| K-4 | 重整頁面 | 開關維持關閉 |
| K-5 | 到設定把連接器停用，回到對話 | 開關**消失** |
| K-6 | 不帶該欄位直接打 API（見下方指令） | KB 仍被查詢 |

K-6 的指令：

```bash
curl -N -X POST http://localhost:3000/api/ai/chats/send \
  -H "Content-Type: application/json" \
  -H "Cookie: <你的登入 cookie>" \
  -d '{"content":"測試舊版客戶端相容性"}'
```
Expected: 串流回應中出現 `tool_call` 且名稱以 `search_` 開頭。
**這一項失敗代表 `!== false` 寫成了 `=== true`，升級後所有既有客戶端都會靜默失去知識庫。**

**K-3 與 K-6 不可跳過** —— 它們是最容易被實作壞掉、且壞掉後最難察覺的兩項。

- [ ] **Step 4: 更新使用手冊**

在 `docs/USER-MANUAL.md` 的 AI 對話章節加入一段：

```markdown
### 外部知識庫開關

輸入框左下角的「外部知識庫」按鈕控制**這一輪對話要不要查外部知識庫**
（Cognee / kb-stack）。

- **預設開啟。** 關掉可以換取更快的回應。
- **關掉不影響 Wiki 內容搜尋** —— 那是 Docmost 自己的索引，與外部知識庫是兩回事。
- 這是「允許」而不是「強制」：開著的時候模型仍可能判斷用不上而不查詢。
  想確認這一輪到底有沒有查，看回應上方的工具呼叫紀錄有沒有 `search_*`。
- 沒有設定任何啟用中的知識庫連接器時，這顆按鈕不會出現。
```

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/i18n
git commit -m "feat: add translations for knowledge base toggle"
git add docs/USER-MANUAL.md
git commit -m "docs: document the external knowledge base toggle"
```

---

## Self-Review

**Spec coverage（對照 [design](./docmost-ai-chat-kb-toggle-design.md)）：**

| Spec 章節 | 對應 Task |
|---|---|
| §2 K1 預設 `true` | Task 1 Step 4（`!== false`）+ Task 3（`getUseKnowledgeBase` 預設 true），兩處都有測試 |
| §2 K2 每則訊息參數、不落庫 | Task 1 Step 3（DTO），無 migration |
| §2 K3 localStorage、非每個對話各自記 | Task 3 |
| §2 K4 只過濾不啟用 | Task 1 Step 4 + 測試「never enables a disabled connector」 |
| §2 K5 不影響 wiki 檢索 | Task 1 測試「leaves the built-in wiki search tool untouched」+ Task 5 文案 + K-3 手動驗證 |
| §2 K6 無連接器時不渲染 | Task 5 測試 + K-5 |
| §2 K7 走 `/ai/config` 不走 `/ai/kb` | Task 2（含「never leaks baseUrl」測試） |
| §2 K8 不做每連接器勾選 | 未實作（刻意） |
| §3.1 位置與形態 | Task 5 Step 4 |
| §3.2 狀態來源 | Task 4（query hook）+ Task 5 |
| §3.3 文案陷阱 | Task 5（兩條測試）+ Task 6 Step 1 |
| §3.4 靠既有工具呼叫顯示自證 | Task 5 Tooltip 文案 + Task 6 使用手冊，無新程式碼 |
| §4.1 DTO | Task 1 Step 3 |
| §4.2 `buildTools` 改動 | Task 1 Step 4 |
| §4.3 `/ai/config` 加欄位 + `/ai/kb` 現象記錄 | Task 2（含「開工前必讀」第 1 點） |
| §5 檔案清單 | 本計畫的 File Structure 一致，另加 `kb-preference.ts` 與兩個測試檔 |
| §6.1 伺服器五個案例 | Task 1 Step 1（五個全在） |
| §6.2 客戶端三個案例 | Task 5 Step 1（六個，涵蓋那三個） |
| §6.3 型別與 lint | Task 1 Step 6、Task 6 Step 2 |
| §7 手動驗證 K-1～K-6 | Task 6 Step 3 |
| §8 明確不做 | 已遵守：無每連接器勾選、無落庫、無強制呼叫、無管理員預設值 |
| §9 風險四項 | 各有對應：文案（Task 5+6）、`!== false`（Task 1+K-6）、允許≠強制（Tooltip）、回應變大（只回 id+name） |

無遺漏。

**與設計書的一處偏離（有意）：** 設計 §5 的檔案清單裡沒有 `kb-preference.ts`，也預期改 `ai-chat.tsx` 做 prop 串接。實作時發現 **`ChatInput` 有四個消費端**（`chat-empty-state`、`ai-chat-layout`、`aside-chat-panel`、`home-ai-prompt`），串接要動四個與此功能無關的檔案。改用共用偏好模組後，`ai-chat.tsx` 完全不用改。這是縮小改動面，不是擴大範圍。

**Placeholder scan：** 無 TBD／「適當處理錯誤」／「類似 Task N」。四處標示「以既有為準」（Task 2 Step 1 的 `AiController` 建構子順序、Task 5 Step 2 的 `@testing-library` 是否存在、Task 5 Step 3 的 `IconDatabase`、Task 6 Step 1 的語言檔位置）都附了確認指令與備案。

**Type consistency：**
- `useKnowledgeBase?: boolean` —— Task 1（server DTO）、Task 4（client params）同名同型。
- `knowledgeBases: Array<{id, name}>` —— Task 2（server 產生）、Task 4（client 型別）、Task 5（`kbConnectors.map(k => k.name)`）一致。
- `KB_PREFERENCE_KEY` / `getUseKnowledgeBase` / `setUseKnowledgeBase` —— Task 3 定義，Task 4（讀）與 Task 5（讀寫）使用，簽章一致。
- `useAiConfigQuery()` 回 `UseQueryResult<AiConfigResponse, Error>` —— Task 4 定義，Task 5 以 `const { data: aiConfig }` 解構，一致。
- 判斷式一律 `!== false`（server）與 `!== "false"`（client localStorage），語意對齊。
