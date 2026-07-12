import { afterEach, describe, expect, it, vi } from "vitest";
import { getPostLoginRedirect, getRedirectParam } from "@/lib/app-route.ts";

describe("public-path login redirects", () => {
  afterEach(() => {
    delete window.CONFIG;
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
  });

  it("strips the public prefix before passing a redirect to React Router", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "/wiki");
    window.history.replaceState(
      {},
      "",
      "/wiki/login?redirect=%2Fwiki%2Fsettings%2Faccount%2Fprofile",
    );

    expect(getPostLoginRedirect()).toBe("/settings/account/profile");
    expect(getRedirectParam()).toBe("/settings/account/profile");
  });

  it("keeps root deployments unchanged", () => {
    vi.stubEnv("DOCMOST_PUBLIC_PATH_PREFIX", "");
    window.history.replaceState({}, "", "/login?redirect=%2Fhome");

    expect(getPostLoginRedirect()).toBe("/home");
  });
});
