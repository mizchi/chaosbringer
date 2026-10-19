import { describe, expect, it } from "vitest";
import { abortedNavigation, UnreachableStreak, unreachableNavigation } from "./unreachable.js";

describe("unreachableNavigation", () => {
  it("names the net error of a navigation that could not connect to the site", () => {
    for (const code of [
      "ERR_CONNECTION_REFUSED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_ADDRESS_UNREACHABLE",
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
    // It accepted the connection: a host shedding load resets some and serves the rest.
    expect(unreachableNavigation("page.goto: net::ERR_CONNECTION_RESET at https://shop.test/", site)).toBeNull();
    // A payment provider being down says nothing about the site under test.
    expect(unreachableNavigation("page.goto: net::ERR_NAME_NOT_RESOLVED at https://pay.test/", site)).toBeNull();
    expect(unreachableNavigation("page.goto: net::ERR_CONNECTION_REFUSED at https://shop.test:8443/", site)).toBeNull();
  });
});

describe("unreachableNavigation and the page's last document request", () => {
  const site = "http://127.0.0.1:4000";
  // What Chromium says both when the site refuses /checkout and when it
  // answers it with a redirect to a host that refuses.
  const refused = "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/checkout#pay";

  it("is null when the site answered the navigation with a redirect", () => {
    expect(unreachableNavigation(refused, site, { url: "http://127.0.0.1:4000/checkout", redirected: true })).toBeNull();
  });

  it("names the failure when the request to the site itself failed", () => {
    expect(unreachableNavigation(refused, site, { url: "http://127.0.0.1:4000/checkout", redirected: false })).toBe(
      "net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/checkout#pay",
    );
  });

  it("goes by the message when the last request was another navigation's", () => {
    expect(unreachableNavigation(refused, site, { url: "http://127.0.0.1:4000/about", redirected: true })).not.toBeNull();
    expect(unreachableNavigation(refused, site, null)).not.toBeNull();
  });
});

describe("abortedNavigation", () => {
  const message = "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/#top";

  it("is true when the failed navigation is one a fault rule aborted", () => {
    expect(abortedNavigation(message, ["http://127.0.0.1:5000/pay", "http://127.0.0.1:4000/"])).toBe(true);
  });

  it("is false for a navigation no rule aborted, and for a failure that is not a net error", () => {
    // A tolerated provider outage before the site refused the next goto.
    expect(abortedNavigation(message, ["http://127.0.0.1:5000/pay"])).toBe(false);
    expect(abortedNavigation(message, [])).toBe(false);
    expect(abortedNavigation("page.click: Timeout 5000ms exceeded.", ["http://127.0.0.1:4000/"])).toBe(false);
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

  it("starts over on a navigation the site answered with a redirect", () => {
    const streak = new UnreachableStreak("http://127.0.0.1:4000", 2);
    expect(streak.record(down)).toBeNull();
    expect(streak.record(down, { url: "http://127.0.0.1:4000/", redirected: true })).toBeNull();
    expect(streak.record(down)).toBeNull();
  });
});
