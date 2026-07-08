# 登入回傳網段 zone(login zone echo)設計書

狀態: draft (2026-07-07)
關聯: [docmost-network-origin-permissions-design.md](./docmost-network-origin-permissions-design.md)

## 1. 需求

為了用**同一個帳號**在**同一台機器**測試內網/辦公網的下載阻擋,需要能在登入後直接確認「這次登入被判成哪個 zone」。

既有的判定規則(不變):

- **帳號密碼登入** → zone 由 docmost `.env` 的 `DOCMOST_NATIVE_LOGIN_ZONE` 決定(預設 `office`)。這是刻意的靜態開關:切 `internal`/`office` 就能用帳密登入模擬內網或辦公網。
- **SSO 登入** → zone 由 wuji-adapter 依 `WUJI_HOST`/`WUJI_ZONE` 推導(`config.wujiZone`),寫進 session metadata。

本設計**只加一層唯讀觀測**:把「登入當下實際蓋到 session 上的 zone」回傳給呼叫端。不新增端點、不改任何判定或蓋章邏輯、不改 session 狀態。

## 2. 範圍與非目標

範圍:

- 帳密登入回應(`POST /api/auth/login` 成功路徑)body 新增 `networkZone` 欄位。
- SSO 的 dry/debug JSON(`?dry=1`/`?debug=1`)新增 `networkZone` 欄位。

非目標(明確不做):

- 不做動態蓋章(登入時讀 entrance header / 真實 IP 決定 zone)。帳密走靜態 `.env` 正是測試需要的開關。
- 不新增獨立探測端點。
- MFA 分支(`auth.controller.login` 內經 `mfaService` 發 token 的路徑)不涵蓋:該路徑的 token 不經 `authService.login`,拿不到 zone。屬已知未涵蓋分支,日後如需再補。

## 3. 設計原則:authoritative(回傳實際蓋的值),不 controller 重算

zone 只在一個地方被決定並寫入 DB:`SessionService.createSessionAndToken` 內的 `resolveSessionZone(...)`(其結果寫進 `user_sessions.metadata.zone`)。本設計把**同一個變數**沿回傳鏈交回呼叫端,而不是在 controller 另外呼一次 `getNativeLoginZone()` 猜一個值。

比 controller 重算好的理由:

1. **回傳值 = DB 實際蓋的值**,同一次計算、同一個變數,不可能分岔。
2. **未來邏輯改動自動跟上**:若日後蓋章多了 override/新輸入,回傳值自動反映;controller 重算只認得靜態 native 這條,會默默回錯值——除錯工具回錯值最危險。
3. **不重複商業邏輯**:「zone 怎麼決定」只留在 `SessionService` 一份,避免 drift。
4. **對所有登入路徑語義一致**:值從 session 建立的回傳鏈流出,日後 register/invitation 要回 zone 直接取用即可。

## 4. 實作

### 4.1 `SessionService.createSessionAndToken`(單一真相來源)

回傳型別 `Promise<string>` → `Promise<{ token: string; zone: 'internal' | 'office' }>`。
內部本就已算好 `const zone = this.resolveSessionZone(options.zone)` 並寫入 metadata,只是把該 zone 與 token 一起回傳。

### 4.2 其餘 4 個呼叫點:只取 `.token`,對外契約不變

- `auth.service.ts` `register` / `setup` / `changePassword`
- `workspace-invitation.service.ts`(accept invitation)

各自 `const { token } = await ...` 後沿用,回傳形狀完全不變 → 零連鎖。

### 4.3 `AuthService.login`:唯一刻意擴充對外形狀

回傳 `{ authToken: token, networkZone: zone }`。

### 4.4 `auth.controller.ts` `login`:回進 body

```ts
const { authToken, networkZone } = await this.authService.login(loginInput, workspace.id);
this.setAuthCookie(res, authToken);
return { networkZone };
```

cookie 行為不變;原本回空 body,新增欄位為純附加、不破壞既有前端。

### 4.5 SSO dry JSON(wuji-adapter)

`src/routes/sso.mjs` 的 `ssoOutcome()` 新增 `networkZone: config.wujiZone ?? null`。正式 302 導轉不動(跨網域 opaque,本就讀不到 body)。

## 5. 驗收

- 帳密登入回應可見 `networkZone`;改 `DOCMOST_NATIVE_LOGIN_ZONE` 重啟並重新登入後,欄位隨之變 → 證明「這次被判成內/外網」。
- SSO 帶 `?dry=1` 的 JSON 可見 `networkZone`(= `config.wujiZone`)。

## 6. 測試

- `session.service.spec.ts`:`createSessionAndToken` 回傳 `{ token, zone }`;`options.zone` 有值時採用之、無值時採單一擁有者的 native 預設;寫入 session 的 metadata 帶 `{ zone }`。
- 既有型別檢查(`tsc --noEmit`)確保回傳型別改動在各呼叫點一致。

## 7. 單一擁有者重構(2026-07-08)

原則:內外網判斷其實回答**兩個本質不同的問題**,各由**一個**擁有者負責,不強行合成一個 function:

- **Q1「登入要蓋哪個 zone」** → 唯一擁有者 `EnvironmentService.getLoginNetworkZone(source, { overrideZone })`(override 優先,否則 native 讀 `.env DOCMOST_NATIVE_LOGIN_ZONE`)。
- **Q2「這個請求屬於哪個 zone」** → 唯一擁有者 `NetworkOriginService.getCurrentUserNetworkZone(req)`(session 章 → deployment → IP/header)。其第一步讀的 session 章正是 Q1 蓋上去的值。

消除的重複:

1. `SessionService.resolveSessionZone` 刪除——它原本抄了一份「override ?? native」precedence。改為直接呼 `getLoginNetworkZone('native', { overrideZone: options.zone })`,Q1 決策從此只在一處。
2. `NetworkOriginService` 內 IP→zone 收斂成單一私有原語 `classifyIp(ip)`(internal 優先於 office),`resolveZone` 呼叫它;docmost 內「IP 落哪一段」只有一份。

未納入(另一層成本):wuji-adapter(另一 process/語言)的 `config.mjs classifyIpZone` 是第二份 CIDR 數學,無法與 docmost 共用同一 function,維持刻意同步的重複;若要真正只留一份需讓 adapter 改呼 docmost 端點或抽共享模組。

行為等價保證:native 無 override → `.env`(預設 office);override internal/office → 用之;override `unknown`/空 → 退回 native;請求解析路徑不動。既有 22 個 `session`/`network-origin` 測試全綠。
