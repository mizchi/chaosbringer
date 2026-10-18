import { describe, expect, it } from "vitest";
import { UnreachableStreak, unreachableNavigation } from "./unreachable.js";

describe("unreachableNavigation", () => {
  it("names the net error of a navigation that could not connect to the site", () => {
    for (const code of [
      "ERR_CONNECTION_REFUSED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_ADDRESS_UNREACHABLE",
      "ERR_CONNECTION_RESET",
      // What Chromium says for http://127.0.0.1:1: it will not dial port 1.
      "ERR_UNSAFE_PORT",
    ]) {
      const message = `page.goto: net::${code} at http://127.0.0.1:4000/login\nCall log:\n  - navigating to "http://127.0.0.1:4000/login"`;
      expect(unreachableNavigation(message, "http://127.0.0.1:4000/")).toBe(`net::${code} at http://127.0.0.1:4000/login`);
    }
  });

  it("finds it inside the message a recipe replay wraps it in", () => {
    const message =
      "recipe-mix: recipe shop/buy failed at step 0 — page.goto: net::ERR_CONNECTION_REFUSED at https://staging.test/cart";
    expect(unreachableNavigation(message, "https://staging.test")).toBe(
      "net::ERR_CONNECTION_REFUSED at https://staging.test/cart",
    );
  });

  it("is null for a failure the site answered for, and for another site being down", () => {
    const site = "https://shop.test";
    expect(unreachableNavigation("page.click: Timeout 5000ms exceeded.", site)).toBeNull();
    // The server answered, badly: a broken site, not a down one.
    expect(unreachableNavigation("page.goto: net::ERR_EMPTY_RESPONSE at https://shop.test/", site)).toBeNull();
    expect(unreachableNavigation("page.goto: net::ERR_ABORTED at https://shop.test/", site)).toBeNull();
    // A payment provider being down says nothing about the site under test.
    expect(unreachableNavigation("page.goto: net::ERR_NAME_NOT_RESOLVED at https://pay.test/", site)).toBeNull();
    expect(unreachableNavigation("page.goto: net::ERR_CONNECTION_REFUSED at https://shop.test:8443/", site)).toBeNull();
  });
});

describe("UnreachableStreak", () => {
  const down = "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/";

  it("gives the reason to stop once the limit is reached in a row", () => {
    const streak = new UnreachableStreak("http://127.0.0.1:4000", 3);
    expect(streak.record(down)).toBeNull();
    expect(streak.record(down)).toBeNull();
    expect(streak.record(down)).toBe(
      "base URL unreachable: http://127.0.0.1:4000 (net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/, 3 iterations in a row)",
    );
  });

  it("starts over after a success or a failure the site answered for", () => {
    const streak = new UnreachableStreak("http://127.0.0.1:4000", 2);
    expect(streak.record(down)).toBeNull();
    expect(streak.record(null)).toBeNull();
    expect(streak.record(down)).toBeNull();
    expect(streak.record("page.click: Timeout 5000ms exceeded.")).toBeNull();
    expect(streak.record(down)).toBeNull();
    expect(streak.record(down)).not.toBeNull();
  });
});
