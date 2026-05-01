import { describe, expect, it } from "vitest";
import { resolveSpaNavigationUrls, type RawSpaNavigation } from "./spa-navigation.js";

function entry(url: string, method: RawSpaNavigation["method"] = "pushState"): RawSpaNavigation {
  return { method, url, timestamp: Date.now() };
}

describe("resolveSpaNavigationUrls", () => {
  const base = "https://app.example/dashboard";

  it("normalises relative URLs against baseUrl", () => {
    const out = resolveSpaNavigationUrls(
      [entry("/items/42"), entry("./settings"), entry("../about")],
      base,
    );
    expect(out).toEqual([
      "https://app.example/items/42",
      "https://app.example/settings",
      "https://app.example/about",
    ]);
  });

  it("dedupes identical resolved URLs across pushState + replaceState", () => {
    const out = resolveSpaNavigationUrls(
      [entry("/items/42", "pushState"), entry("/items/42", "replaceState")],
      base,
    );
    expect(out).toHaveLength(1);
  });

  it("drops javascript: / mailto: / tel: / data: / blob: pseudo-URLs", () => {
    const out = resolveSpaNavigationUrls(
      [
        entry("javascript:void(0)"),
        entry("mailto:a@b"),
        entry("tel:1234"),
        entry("data:text/plain,hello"),
        entry("blob:https://app/x"),
        entry("/keepme"),
      ],
      base,
    );
    expect(out).toEqual(["https://app.example/keepme"]);
  });

  it("drops malformed URLs that throw on `new URL`", () => {
    // An empty-string URL is the only one likely to fail in practice;
    // others are caught by the scheme filter or normalised by URL().
    // We ensure the function does not propagate the exception either way.
    const out = resolveSpaNavigationUrls(
      [entry(""), entry(" "), entry("/valid")],
      base,
    );
    expect(out).toEqual(["https://app.example/valid"]);
  });

  it("handles fragment-only navigations (kept — same-origin SPAs route off the hash)", () => {
    const out = resolveSpaNavigationUrls(
      [entry("#section"), entry("?tab=2"), entry("/route?tab=2#frag")],
      base,
    );
    expect(out).toEqual([
      "https://app.example/dashboard#section",
      "https://app.example/dashboard?tab=2",
      "https://app.example/route?tab=2#frag",
    ]);
  });

  it("handles cross-origin pushState by keeping the absolute URL (the crawler decides via ownsUrl)", () => {
    // History.pushState technically rejects cross-origin, but if a fixture
    // simulates it via direct dispatch we still produce the absolute URL —
    // chaosbringer's queue feeder filters by origin.
    const out = resolveSpaNavigationUrls(
      [entry("https://other.example/foo")],
      base,
    );
    expect(out).toEqual(["https://other.example/foo"]);
  });

  it("returns [] for empty input", () => {
    expect(resolveSpaNavigationUrls([], base)).toEqual([]);
  });
});
