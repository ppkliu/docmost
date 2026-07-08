# Editor Toolbar Default + Download-Block Message i18n/Position Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fixed editor toolbar default ON via a docmost `.env` var, and make the network-origin download-block message i18n-aware (Simplified Chinese under zh-CN) and render it top-center instead of bottom.

**Architecture:** Three independent changes, all in the docmost fork. (1) A new `EDITOR_TOOLBAR_DEFAULT` env is exposed to the client through docmost's existing `window.CONFIG` injection ([static.module.ts](../../apps/server/src/integrations/static/static.module.ts)) and read by `lib/config.ts`; the four client sites that read `editorToolbar` fall back to it instead of hardcoded `false`. (2) The hardcoded English block message in `lib/network-origin.ts` moves to i18n keys present in `en-US` + `zh-CN`. (3) The two `notifications.show` calls for that message pass `position: "top-center"` (Mantine 8 supports per-notification position — no global change, no second store).

**Tech Stack:** NestJS + Fastify (server), React + Vite + Jotai + Mantine 8.3.18 + i18next (client), vitest (client tests).

## Global Constraints

- Do **not** modify docmost outside the files named here; keep the change surface minimal (fork stays close to upstream — see REPOS.md).
- Per-user preference wins: `EDITOR_TOOLBAR_DEFAULT` only sets the fallback when a user has never toggled `editorToolbar`. Never override a stored user value.
- No AI-attribution strings in code or commit messages. Commit messages in English, `type: message` form.
- Verification gate (CLAUDE.md verify-first): server `npx tsc --noEmit -p apps/server/tsconfig.json` (the 2 pre-existing `collaboration/extensions/redis-sync/*` errors are unrelated and expected); client `cd apps/client && npx eslint .` on changed files. Report failures honestly.
- i18n coverage for this change: `en-US` (source, keeps English) + `zh-CN` (Simplified Chinese) only. Other locales fall back automatically.
- The three natural-language i18n keys (used verbatim as JSON keys, docmost's natural-key convention):
  - `This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.`
  - `This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.`
  - `This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.`

---

### Task 1: Expose `EDITOR_TOOLBAR_DEFAULT` from server env into `window.CONFIG`

**Files:**
- Modify: `apps/server/src/integrations/environment/environment.service.ts` (add getter near `getFileUploadSizeLimit`, ~line 93)
- Modify: `apps/server/src/integrations/static/static.module.ts:34-53` (add to `configString`)
- Modify: `.env` and `.env.example` (docmost root)

**Interfaces:**
- Produces: `EnvironmentService.getEditorToolbarDefault(): boolean` — `true` unless env is exactly `false` (case-insensitive). Injected into `window.CONFIG.EDITOR_TOOLBAR_DEFAULT` as a boolean.

- [ ] **Step 1: Add the env getter**

In `environment.service.ts`, after `getFileImportSizeLimit()` (~line 97) add:

```ts
  getEditorToolbarDefault(): boolean {
    // Default ON. Only an explicit `false` disables it; blank/unset stays true.
    return (
      this.configService.get<string>('EDITOR_TOOLBAR_DEFAULT') ?? 'true'
    ).toLowerCase().trim() !== 'false';
  }
```

- [ ] **Step 2: Inject it into `window.CONFIG`**

In `static.module.ts`, inside the `configString` object (after `POSTHOG_KEY: ...,` line 52) add:

```ts
        EDITOR_TOOLBAR_DEFAULT:
          this.environmentService.getEditorToolbarDefault(),
```

- [ ] **Step 3: Add the env var to `.env` and `.env.example`**

Append to both `docmost/.env` and `docmost/.env.example`:

```dotenv
# Fixed editor toolbar shown above the editor by default. Users can still
# turn it off per-account in Preferences. Set to false to default it OFF.
EDITOR_TOOLBAR_DEFAULT=true
```

- [ ] **Step 4: Typecheck the server**

Run (from `docmost/`): `npx tsc --noEmit -p apps/server/tsconfig.json`
Expected: no NEW errors. Only the 2 known `collaboration/extensions/redis-sync/*` errors may appear.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/integrations/environment/environment.service.ts apps/server/src/integrations/static/static.module.ts .env.example
git commit -m "feat: expose EDITOR_TOOLBAR_DEFAULT env to client config"
```

Note: `.env` is git-ignored / must not be committed (CLAUDE.md) — edit it on disk but only stage `.env.example`.

---

### Task 2: Client reads the env default and applies it to the four toolbar sites

**Files:**
- Modify: `apps/client/src/lib/config.ts` (add exported helper after `getFileImportSizeLimit`, ~line 83)
- Modify: `apps/client/src/features/user/components/fixed-toolbar-pref.tsx:17`
- Modify: `apps/client/src/features/editor/full-editor.tsx:71`
- Modify: `apps/client/src/features/editor/components/bubble-menu/bubble-menu.tsx:53`
- Modify: `apps/client/src/ee/template/pages/template-editor.tsx:50`
- Test: `apps/client/src/lib/config.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 at compile time (the value arrives at runtime via `window.CONFIG`).
- Produces: `getEditorToolbarDefault(): boolean` exported from `lib/config.ts`. Returns `true` when `window.CONFIG.EDITOR_TOOLBAR_DEFAULT` is unset (dev `process.env` too), `castToBoolean` otherwise.

- [ ] **Step 1: Write the failing test**

Create `apps/client/src/lib/config.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEditorToolbarDefault } from "@/lib/config";

describe("getEditorToolbarDefault", () => {
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete window.CONFIG;
    vi.unstubAllEnvs();
  });

  it("defaults to true when unset", () => {
    vi.stubEnv("DEV", false);
    window.CONFIG = {};
    expect(getEditorToolbarDefault()).toBe(true);
  });

  it("is false when explicitly disabled", () => {
    vi.stubEnv("DEV", false);
    window.CONFIG = { EDITOR_TOOLBAR_DEFAULT: "false" };
    expect(getEditorToolbarDefault()).toBe(false);
  });

  it("is true when explicitly enabled", () => {
    vi.stubEnv("DEV", false);
    window.CONFIG = { EDITOR_TOOLBAR_DEFAULT: "true" };
    expect(getEditorToolbarDefault()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `docmost/apps/client`): `npx vitest run src/lib/config.test.ts`
Expected: FAIL — `getEditorToolbarDefault` is not exported.

- [ ] **Step 3: Add the helper to `lib/config.ts`**

After `getFileImportSizeLimit()` (~line 83) add:

```ts
export function getEditorToolbarDefault(): boolean {
  // Default ON; server injects a boolean via window.CONFIG, dev reads env.
  return castToBoolean(getConfigValue("EDITOR_TOOLBAR_DEFAULT", "true"));
}
```

`castToBoolean` and `getConfigValue` already exist in this file (imported / defined at line 105).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Flip the four read sites**

In each file, replace the fallback `?? false` with `?? getEditorToolbarDefault()` and add the import `import { getEditorToolbarDefault } from "@/lib/config";` (only where not already importing from `@/lib/config`).

`features/user/components/fixed-toolbar-pref.tsx:17`:
```ts
  const [checked, setChecked] = useState(
    user.settings?.preferences?.editorToolbar ?? getEditorToolbarDefault(),
  );
```

`features/editor/full-editor.tsx:71`:
```ts
    user.settings?.preferences?.editorToolbar ?? getEditorToolbarDefault();
```

`features/editor/components/bubble-menu/bubble-menu.tsx:53`:
```ts
    user?.settings?.preferences?.editorToolbar ?? getEditorToolbarDefault();
```

`ee/template/pages/template-editor.tsx:50`:
```ts
    user?.settings?.preferences?.editorToolbar ?? getEditorToolbarDefault();
```

- [ ] **Step 6: Lint + typecheck the changed client files**

Run (from `docmost/apps/client`):
```bash
npx eslint src/lib/config.ts src/features/user/components/fixed-toolbar-pref.tsx src/features/editor/full-editor.tsx src/features/editor/components/bubble-menu/bubble-menu.tsx src/ee/template/pages/template-editor.tsx
npx vitest run src/lib/config.test.ts
```
Expected: eslint clean; vitest PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/lib/config.ts apps/client/src/lib/config.test.ts apps/client/src/features/user/components/fixed-toolbar-pref.tsx apps/client/src/features/editor/full-editor.tsx apps/client/src/features/editor/components/bubble-menu/bubble-menu.tsx apps/client/src/ee/template/pages/template-editor.tsx
git commit -m "feat: default fixed editor toolbar on via EDITOR_TOOLBAR_DEFAULT"
```

---

### Task 3: i18n the download-block message and render it top-center

**Files:**
- Modify: `apps/client/src/lib/network-origin.ts:6-13,57,79`
- Modify: `apps/client/public/locales/en-US/translation.json`
- Modify: `apps/client/public/locales/zh-CN/translation.json`

**Interfaces:**
- Consumes: the default i18n instance `import i18n from "@/i18n"` (default export of `apps/client/src/i18n.ts`).
- Produces: no new exported symbols; `restrictedMessage(action)` now returns a translated string.

- [ ] **Step 1: Add the three keys to `en-US/translation.json`**

Insert these entries (keep JSON valid — alphabetical placement is nice-to-have, not required; a trailing comma on the previous line if needed):

```json
  "This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  "This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  "This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
```

- [ ] **Step 2: Add the three keys to `zh-CN/translation.json`**

```json
  "This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "此下载在办公网络中被阻止，因为该页面、子页面或附件是在内部网络中创建的。",
  "This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "此导出在办公网络中被阻止，因为该页面、子页面或附件是在内部网络中创建的。",
  "This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.": "此打印在办公网络中被阻止，因为该页面、子页面或附件是在内部网络中创建的。",
```

- [ ] **Step 3: Verify both JSON files still parse**

Run (from `docmost/apps/client`):
```bash
node -e "require('./public/locales/en-US/translation.json'); require('./public/locales/zh-CN/translation.json'); console.log('json ok')"
```
Expected: `json ok`.

- [ ] **Step 4: Rewrite the message builder in `network-origin.ts` to use i18n**

Replace lines 6-13 (`actionLabel` + `restrictedMessage`) with:

```ts
import i18n from "@/i18n";

const restrictedMessageKey: Record<RestrictedAction, string> = {
  download:
    "This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  export:
    "This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  print:
    "This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
};

const restrictedMessage = (action: RestrictedAction) =>
  i18n.t(restrictedMessageKey[action]);
```

(Add the `import i18n from "@/i18n";` at the top with the other imports; remove the now-unused `actionLabel`.)

- [ ] **Step 5: Add `position: "top-center"` to the two block-message toasts**

`network-origin.ts` `notifyNetworkOriginBlocked` (~line 57):
```ts
  notifications.show({ message, color: "red", position: "top-center" });
```

`network-origin.ts` `downloadWithNetworkOriginGuard` blocked branch (~line 79):
```ts
      notifications.show({
        message: restrictedMessage("download"),
        color: "red",
        position: "top-center",
      });
```

Leave the generic `"Download failed"` toast (line ~85) unchanged — out of scope.

- [ ] **Step 6: Lint + typecheck**

Run (from `docmost/apps/client`):
```bash
npx eslint src/lib/network-origin.ts
```
Expected: clean (no unused `actionLabel`, `i18n` import resolves, `position` accepted by `NotificationData`).

- [ ] **Step 7: Manual verification**

1. Build/run the client, log in on an account with UI language = 简体中文.
2. On the **office** network (or a zone where the resource origin is `internal`/`mrdoc`), trigger a blocked download/export/print.
3. Confirm the toast text is Simplified Chinese and appears **top-center**; confirm other unrelated toasts still appear bottom-center.

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/lib/network-origin.ts
git commit -m "feat: i18n network-origin block message and show it top-center"
git add apps/client/public/locales/en-US/translation.json apps/client/public/locales/zh-CN/translation.json
git commit -m "chore: add zh-CN/en-US strings for network-origin block message"
```

(Per CLAUDE.md: code and locale/data files go in separate commits — network-origin.ts first, then the translation JSON.)

---

## Self-Review

**Spec coverage:**
- Fixed toolbar default ON + `.env`/`.env.example` → Tasks 1 & 2 ✓ (env plumbing, `.env`/`.env.example`, four read sites, per-user override preserved).
- Block message i18n, Simplified Chinese under zh-CN → Task 3 steps 1-4 ✓ (en-US + zh-CN keys, `i18n.t`).
- Block message top-center → Task 3 step 5 ✓ (per-notification `position`, no global change).

**Placeholder scan:** none — all code and commands are concrete.

**Type consistency:** `getEditorToolbarDefault` returns `boolean` in both server (`EnvironmentService`) and client (`lib/config.ts`); the four client sites consume the client `boolean`. `restrictedMessage(action: RestrictedAction): string` unchanged signature. `position: "top-center"` is a valid `NotificationPosition` per `@mantine/notifications` d.ts.

**Known caveats:**
- `.env` must not be committed (only `.env.example`).
- `restrictedMessage` now depends on i18n being initialized before first use; `i18n.ts` runs at app bootstrap (imported in `main.tsx`) so by the time a toast fires it is ready.
