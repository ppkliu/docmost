import { describe, expect, it } from "vitest";
import { consumeRedirectNotice } from "./redirect-notice.utils";

describe("consumeRedirectNotice", () => {
  it("shows an allowlisted notice in red and preserves other URL parts", () => {
    const shown: Array<{ message: string; color: string }> = [];
    const replaced: string[] = [];

    const consumed = consumeRedirectNotice({
      href: "https://wiki.test/wiki/home?notice=space-forbidden&tab=recent#top",
      show: (input) => shown.push(input),
      replace: (url) => replaced.push(url),
      translate: (key) => `translated:${key}`,
    });

    expect(consumed).toBe(true);
    expect(shown).toEqual([
      { message: "translated:redirectNotice.spaceForbidden", color: "red" },
    ]);
    expect(replaced).toEqual(["/wiki/home?tab=recent#top"]);
  });

  it("removes the notice query entirely when it is the only query", () => {
    const replaced: string[] = [];

    consumeRedirectNotice({
      href: "https://wiki.test/wiki/login?notice=sso-invalid",
      show: () => {},
      replace: (url) => replaced.push(url),
      translate: (key) => key,
    });

    expect(replaced).toEqual(["/wiki/login"]);
  });

  it("ignores unknown notice codes without showing or changing history", () => {
    let calls = 0;

    const consumed = consumeRedirectNotice({
      href: "https://wiki.test/home?notice=raw-server-error",
      show: () => { calls += 1; },
      replace: () => { calls += 1; },
      translate: (key) => key,
    });

    expect(consumed).toBe(false);
    expect(calls).toBe(0);
  });

  it("supports every fixed adapter notice code", () => {
    const codes = [
      "space-forbidden",
      "page-forbidden",
      "space-invalid",
      "space-not-found",
      "page-invalid",
      "page-not-found",
      "page-space-mismatch",
      "grant-apply-failed",
      "sso-invalid",
      "sso-unavailable",
      "sso-failed",
    ];

    for (const code of codes) {
      let shown = 0;
      expect(consumeRedirectNotice({
        href: `https://wiki.test/home?notice=${code}`,
        show: ({ color }) => { expect(color).toBe("red"); shown += 1; },
        replace: () => {},
        translate: (key) => key,
      })).toBe(true);
      expect(shown).toBe(1);
    }
  });
});
