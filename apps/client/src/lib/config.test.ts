import { afterEach, describe, expect, it, vi } from "vitest";
import { getEditorToolbarDefault } from "@/lib/config";

describe("getEditorToolbarDefault", () => {
  afterEach(() => {
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
