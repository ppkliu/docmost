import { afterEach, describe, expect, it, vi } from "vitest";
import { getEditorToolbarDefault, getPublicUrl } from "@/lib/config";

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

describe("getPublicUrl", () => {
  afterEach(() => {
    delete window.CONFIG;
    vi.unstubAllEnvs();
  });

  it("adds the public path prefix to share links", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "/wiki");
    expect(getPublicUrl("/share/abc123/p/my-page-xYz")).toBe(
      `${window.location.origin}/wiki/share/abc123/p/my-page-xYz`,
    );
  });

  it("does not double the prefix when the path already has it", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "/wiki");
    expect(getPublicUrl("/wiki/s/general/p/page-xYz")).toBe(
      `${window.location.origin}/wiki/s/general/p/page-xYz`,
    );
  });

  it("keeps root deployments unchanged", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "");
    expect(getPublicUrl("/share/abc123/p/my-page-xYz")).toBe(
      `${window.location.origin}/share/abc123/p/my-page-xYz`,
    );
  });
});
