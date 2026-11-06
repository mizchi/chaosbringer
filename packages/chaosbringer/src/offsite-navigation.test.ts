import { describe, expect, it } from "vitest";
import {
  blockedTrigger,
  compileOffsiteAllow,
  describeOffsiteNavigation,
  isOffsiteRedirect,
  noOffsiteRedirect,
  offsiteNavigation,
  offsiteRedirectAllowOf,
  offsiteRedirects,
  reflectedIn,
} from "./offsite-navigation.js";
import type { InvariantContext, OffsiteNavigation } from "./types.js";

const SITE = "http://127.0.0.1:4400";
const EVIL = "http://localhost:4401/phish";

describe("reflectedIn", () => {
  it("finds the target in a query parameter, as written or URL-decoded", () => {
    expect(reflectedIn(`${SITE}/go?next=${EVIL}`, EVIL)).toEqual({ in: "query", param: "next" });
    expect(reflectedIn(`${SITE}/go?a=1&next=${encodeURIComponent(EVIL)}`, EVIL)).toEqual({ in: "query", param: "next" });
    // Encoded twice, as a value passed through another link.
    expect(reflectedIn(`${SITE}/go?u=${encodeURIComponent(encodeURIComponent(EVIL))}`, EVIL)).toEqual({ in: "query", param: "u" });
  });

  it("finds a protocol-relative, backslash or bare-host target", () => {
    expect(reflectedIn(`${SITE}/go?next=//localhost:4401/x`, EVIL)).toEqual({ in: "query", param: "next" });
    expect(reflectedIn(`${SITE}/go?next=${encodeURIComponent("/\\localhost:4401")}`, EVIL)).toEqual({ in: "query", param: "next" });
    expect(reflectedIn(`${SITE}/go?host=LOCALHOST:4401`, EVIL)).toEqual({ in: "query", param: "host" });
  });

  it("finds the target in the fragment, as written or URL-decoded", () => {
    expect(reflectedIn(`${SITE}/#return=${EVIL}`, EVIL)).toEqual({ in: "fragment" });
    expect(reflectedIn(`${SITE}/#/login?next=${encodeURIComponent(EVIL)}`, EVIL)).toEqual({ in: "fragment" });
  });

  it("does not count a fixed target, another host that shares a prefix, or the path", () => {
    expect(reflectedIn(`${SITE}/chat`, EVIL)).toBeUndefined();
    expect(reflectedIn(`${SITE}/go?next=/home`, EVIL)).toBeUndefined();
    expect(reflectedIn(`${SITE}/go?next=http://localhost:44012/x`, EVIL)).toBeUndefined();
    expect(reflectedIn("http://127.0.0.1:4400/go?next=https://evil.example.com/", "https://evil.example/")).toBeUndefined();
    expect(reflectedIn(`${SITE}/out/localhost:4401`, EVIL)).toBeUndefined();
    expect(reflectedIn("not a url", EVIL)).toBeUndefined();
  });
});

describe("blockedTrigger", () => {
  it("names an iframe, a meta refresh, a step and a script, in that order", () => {
    expect(blockedTrigger({ mainFrame: false, stepRunning: true, reason: "scriptInitiated" })).toBe("frame");
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "metaTagRefresh" })).toBe("meta-refresh");
    expect(blockedTrigger({ mainFrame: true, stepRunning: false, reason: "metaTagRefresh" })).toBe("meta-refresh");
    expect(blockedTrigger({ mainFrame: true, stepRunning: false, reason: "httpHeaderRefresh" })).toBe("meta-refresh");
    expect(blockedTrigger({ mainFrame: true, stepRunning: false, reason: "scriptInitiated" })).toBe("script");
    // No CDP reason (a page without CDP): a script.
    expect(blockedTrigger({ mainFrame: true, stepRunning: false })).toBe("script");
  });

  it("keeps a step's link, form or fixed-URL handler a click, and not a handler that follows the page's own URL", () => {
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "anchorClick", reflected: true })).toBe("click");
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "formSubmissionGet", reflected: true })).toBe("click");
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "formSubmissionPost" })).toBe("click");
    // A share button: location.href = "https://partner.example/".
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "scriptInitiated" })).toBe("click");
    // A "Continue" button: location.href = new URLSearchParams(location.search).get("next").
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reason: "scriptInitiated", reflected: true })).toBe("script");
    expect(blockedTrigger({ mainFrame: true, stepRunning: true, reflected: true })).toBe("script");
    expect(blockedTrigger({ mainFrame: true, stepRunning: true })).toBe("click");
  });
});

describe("offsiteNavigation / describeOffsiteNavigation", () => {
  it("records the reflection, never for an iframe", () => {
    const from = `${SITE}/go?next=${encodeURIComponent(EVIL)}`;
    expect(offsiteNavigation(from, EVIL, "script")).toEqual({ from, to: EVIL, trigger: "script", reflected: { in: "query", param: "next" } });
    expect(offsiteNavigation(from, EVIL, "frame")).toEqual({ from, to: EVIL, trigger: "frame" });
  });

  it("lists the page, the target, the trigger, the reflection and a failure", () => {
    const nav = offsiteNavigation(`${SITE}/go?next=${EVIL}`, EVIL, "server-redirect", { failed: "net::ERR_CONNECTION_REFUSED" });
    expect(describeOffsiteNavigation(nav)).toBe(
      `${SITE}/go?next=${EVIL} -> ${EVIL} (server redirect; target from the "next" query parameter; failed: net::ERR_CONNECTION_REFUSED)`,
    );
    expect(describeOffsiteNavigation(offsiteNavigation(`${SITE}/chat`, EVIL, "meta-refresh"))).toBe(`${SITE}/chat -> ${EVIL} (meta refresh)`);
  });

  it("counts script, meta refresh and server redirects as redirects, not clicks or iframes", () => {
    const pages = [
      { offsiteNavigations: [offsiteNavigation(SITE, EVIL, "click"), offsiteNavigation(SITE, EVIL, "frame")] },
      { offsiteNavigations: [offsiteNavigation(`${SITE}/a`, EVIL, "script"), offsiteNavigation(`${SITE}/b`, EVIL, "meta-refresh")] },
      {},
      { offsiteNavigations: [offsiteNavigation(`${SITE}/c`, EVIL, "server-redirect")] },
    ];
    expect(offsiteRedirects(pages).map((n) => n.trigger)).toEqual(["script", "meta-refresh", "server-redirect"]);
    expect(isOffsiteRedirect({ trigger: "click" })).toBe(false);
  });

  it("counts a redirect that fired again (a delayed one, each time the crawler went back) once", () => {
    const again = offsiteNavigation(`${SITE}/delayed`, EVIL, "script");
    const elsewhere = offsiteNavigation(`${SITE}/other`, EVIL, "script");
    expect(offsiteRedirects([{ offsiteNavigations: [again, again, again] }, { offsiteNavigations: [elsewhere, again] }])).toEqual([again, elsewhere]);
  });
});

describe("compileOffsiteAllow", () => {
  it("allows a whole origin, or what a RegExp matches", () => {
    const allowed = compileOffsiteAllow(["https://login.example.com", "http://localhost:4401/", /^https:\/\/pay\.example\.net\/checkout/]);
    expect(allowed("https://login.example.com/authorize?x=1")).toBe(true);
    expect(allowed(EVIL)).toBe(true);
    expect(allowed("https://pay.example.net/checkout/1")).toBe(true);
    expect(allowed("https://pay.example.net/other")).toBe(false);
    expect(allowed("https://login.example.com.evil.example/")).toBe(false);
    expect(allowed("http://login.example.com/")).toBe(false);
  });

  it("refuses a string that is not a bare origin", () => {
    expect(() => compileOffsiteAllow(["https://login.example.com/authorize"])).toThrow(/is not an origin/);
    expect(() => compileOffsiteAllow(["login.example.com"])).toThrow(/is not an origin/);
  });
});

describe("noOffsiteRedirect", () => {
  const ctx = (offsiteNavigations: OffsiteNavigation[]): InvariantContext =>
    ({ page: undefined, url: SITE, errors: [], state: new Map(), offsiteNavigations }) as unknown as InvariantContext;

  it("runs afterVisit under its own name", () => {
    const inv = noOffsiteRedirect();
    expect(inv.name).toBe("navigation.no-offsite-redirect");
    expect(inv.when).toBe("afterVisit");
  });

  it("passes clicks, iframes and a context with nothing recorded", async () => {
    const inv = noOffsiteRedirect();
    expect(await inv.check(ctx([offsiteNavigation(SITE, EVIL, "click"), offsiteNavigation(SITE, EVIL, "frame")]))).toBe(true);
    expect(await inv.check({ page: undefined, url: SITE, errors: [], state: new Map() } as unknown as InvariantContext)).toBe(true);
  });

  it("calls a reflected target an open redirect, and names the parameter", async () => {
    const from = `${SITE}/go?next=${encodeURIComponent(EVIL)}`;
    expect(await noOffsiteRedirect().check(ctx([offsiteNavigation(from, EVIL, "script")]))).toBe(
      `open redirect: ${from} -> ${EVIL} (script redirect, to the URL in its "next" query parameter)`,
    );
    expect(await noOffsiteRedirect().check(ctx([offsiteNavigation(`${SITE}/#${EVIL}`, EVIL, "meta-refresh")]))).toBe(
      `open redirect: ${SITE}/#${EVIL} -> ${EVIL} (meta refresh, to the URL in its fragment)`,
    );
  });

  it("fails a fixed off-site redirect too, and says when it failed to load", async () => {
    const nav = offsiteNavigation(`${SITE}/chat`, EVIL, "server-redirect", { failed: "net::ERR_CONNECTION_REFUSED" });
    expect(await noOffsiteRedirect().check(ctx([nav]))).toBe(
      `off-site redirect: ${SITE}/chat -> ${EVIL} (server redirect; it failed to load: net::ERR_CONNECTION_REFUSED)`,
    );
  });

  it("lets an allowed origin through, such as an SSO provider", async () => {
    const sso = offsiteNavigation(`${SITE}/login`, "http://localhost:4401/authorize?client=x", "server-redirect");
    expect(await noOffsiteRedirect({ allow: ["http://localhost:4401"] }).check(ctx([sso]))).toBe(true);
    expect(await noOffsiteRedirect({ allow: ["http://localhost:4402"] }).check(ctx([sso]))).toMatch(/^off-site redirect: /);
  });

  it("lists a redirect that fired again once", async () => {
    const nav = offsiteNavigation(`${SITE}/delayed`, EVIL, "script");
    expect(await noOffsiteRedirect().check(ctx([nav, nav, nav]))).toBe(`off-site redirect: ${SITE}/delayed -> ${EVIL} (script redirect)`);
  });

  it("carries its allow list, kept by a spread and left out of JSON, and no other invariant has one", () => {
    const inv = noOffsiteRedirect({ allow: ["http://localhost:4401"] });
    expect(offsiteRedirectAllowOf(inv)?.(EVIL)).toBe(true);
    expect(offsiteRedirectAllowOf(inv)?.("http://localhost:4402/")).toBe(false);
    expect(offsiteRedirectAllowOf({ ...inv, name: "renamed" })?.(EVIL)).toBe(true);
    expect(JSON.parse(JSON.stringify(inv))).toEqual({ name: "navigation.no-offsite-redirect", when: "afterVisit" });
    expect(offsiteRedirectAllowOf({ name: "x", check: () => true })).toBeUndefined();
  });

  it("lists three and counts the rest", async () => {
    const navs = [1, 2, 3, 4, 5].map((i) => offsiteNavigation(`${SITE}/r${i}`, `${EVIL}${i}`, "script"));
    const message = (await noOffsiteRedirect().check(ctx(navs))) as string;
    expect(message.split("; off-site redirect").length).toBe(3);
    expect(message).toMatch(/ \(\+2 more\)$/);
  });
});
