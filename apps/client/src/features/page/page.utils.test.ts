import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPublicShareLink } from "@/features/page/page.utils";

describe("buildPublicShareLink", () => {
  afterEach(() => {
    delete window.CONFIG;
    vi.unstubAllEnvs();
  });

  it("builds the keyed share link under the public path prefix", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "/wiki");
    expect(
      buildPublicShareLink({
        shareId: "k3x9",
        pageSlugId: "AbC123xYz0",
        pageTitle: "Meeting Notes",
      }),
    ).toBe(`${window.location.origin}/wiki/share/k3x9/p/meeting-notes-AbC123xYz0`);
  });

  it("keeps root deployments unchanged", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "");
    expect(
      buildPublicShareLink({
        shareId: "k3x9",
        pageSlugId: "AbC123xYz0",
        pageTitle: "Meeting Notes",
      }),
    ).toBe(`${window.location.origin}/share/k3x9/p/meeting-notes-AbC123xYz0`);
  });
});
