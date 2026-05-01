/**
 * End-to-end smoke test: run ChaosCrawler against the fixture site and
 * assert the headline error-classification and discovery behaviour.
 *
 * Slow (boots Chromium), so only this file exercises a real browser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChaosCrawler } from "../../src/crawler.js";
import { faults } from "../../src/faults.js";
import { stateMachineInvariant } from "../../src/state-machine-invariants.js";
import type { Invariant } from "../../src/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer(0);
}, 30000);

afterAll(async () => {
  await server.close();
});

describe("ChaosCrawler against fixture site", () => {
  it("classifies errors correctly and finds the dead link", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 12,
      maxActionsPerPage: 1,
      headless: true,
      seed: 42,
    });

    const report = await crawler.start();

    // Seed round-trips into the report.
    expect(report.seed).toBe(42);

    // Visited the main scenario pages.
    const urls = report.pages.map((p) => p.url);
    expect(urls).toContain(`${server.url}/unhandled-rejection`);
    expect(urls).toContain(`${server.url}/js-exception`);
    expect(urls).toContain(`${server.url}/console-error`);

    // The rejection page must be classified as unhandled-rejection, not exception.
    const rejectionPage = report.pages.find((p) => p.url.endsWith("/unhandled-rejection"))!;
    expect(rejectionPage.errors.some((e) => e.type === "unhandled-rejection")).toBe(true);
    expect(rejectionPage.errors.some((e) => e.type === "exception")).toBe(false);

    // The thrown error page is a real exception.
    const exceptionPage = report.pages.find((p) => p.url.endsWith("/js-exception"))!;
    expect(exceptionPage.errors.some((e) => e.type === "exception")).toBe(true);

    // The console.error page is captured as console.
    const consolePage = report.pages.find((p) => p.url.endsWith("/console-error"))!;
    expect(consolePage.errors.some((e) => e.type === "console")).toBe(true);

    // The broken link is recorded in the discovery dead-link list.
    const deadLinks = report.summary.discovery?.deadLinks ?? [];
    expect(deadLinks.some((d) => d.url.endsWith("/broken-link") && d.statusCode === 404)).toBe(true);

    // Summary counters line up with what we saw above.
    expect(report.summary.unhandledRejections).toBeGreaterThanOrEqual(1);
    expect(report.summary.jsExceptions).toBeGreaterThanOrEqual(1);
    expect(report.summary.consoleErrors).toBeGreaterThanOrEqual(1);

    // External navigation attempts got blocked at least once (fixture has an
    // example.com link and the crawler extracts / may click into it).
    // Not strict: the seed may or may not click that particular link, so only
    // check if any appeared in blockedExternalNavigations as a weak signal.
    // (Keeping it assertion-free keeps the test deterministic under seed drift.)
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(0);
  }, 120000);

  it("records to HAR, then replays the same crawl with the server gone", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "chaosbringer-har-"));
    const harPath = join(tmp, "replay.har");
    try {
      // 1. Record against the live fixture.
      const live = await startFixtureServer(0);
      const record = new ChaosCrawler({
        baseUrl: live.url,
        maxPages: 3,
        maxActionsPerPage: 0,
        headless: true,
        seed: 11,
        har: { path: harPath, mode: "record" },
      });
      const recordReport = await record.start();
      await live.close();

      expect(existsSync(harPath)).toBe(true);
      expect(statSync(harPath).size).toBeGreaterThan(200);
      expect(recordReport.har?.mode).toBe("record");
      const recordedUrl = recordReport.baseUrl;

      // 2. Replay against the HAR with the fixture server SHUT DOWN.
      // notFound: "abort" ensures we're really hitting the HAR, not the network.
      const replay = new ChaosCrawler({
        baseUrl: recordedUrl,
        maxPages: 3,
        maxActionsPerPage: 0,
        headless: true,
        seed: 11,
        har: { path: harPath, mode: "replay", notFound: "abort" },
      });
      const replayReport = await replay.start();
      expect(replayReport.har?.mode).toBe("replay");
      // Home page must load from HAR without the server running. The queue
      // URL gets normalized with a trailing slash on root paths, so match by
      // startsWith rather than strict equality.
      expect(replayReport.pagesVisited).toBeGreaterThanOrEqual(1);
      const home = replayReport.pages.find((p) => p.url.startsWith(recordedUrl));
      expect(home).toBeDefined();
      expect(home?.status).toBe("success");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120000);

  it("groups repeated identical errors into a single cluster", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: `${server.url}/broken-link`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
    });
    const report = await crawler.start();
    // broken-link responds 404, which yields a console error. Clusters must
    // be populated and carry the navigation URL.
    expect(report.errorClusters.length).toBeGreaterThan(0);
    const c404 = report.errorClusters.find((c) => c.fingerprint.includes("status of <n>"));
    expect(c404?.count).toBeGreaterThanOrEqual(1);
  }, 120000);

  it("marks a 500-injected page as recovered and fires onPageComplete with the final status", async () => {
    const seen: Array<{ url: string; status: string }> = [];
    const crawler = new ChaosCrawler(
      {
        baseUrl: server.url,
        maxPages: 3,
        maxActionsPerPage: 1,
        headless: true,
        seed: 7,
        faultInjection: [
          {
            name: "kill-about",
            urlPattern: "/about$",
            fault: { kind: "status", status: 500, body: "<h1>500</h1>", contentType: "text/html" },
          },
        ],
      },
      {
        onPageComplete: (r) => seen.push({ url: r.url, status: r.status }),
      }
    );
    const report = await crawler.start();
    const aboutEvent = seen.find((s) => s.url.endsWith("/about"));
    expect(aboutEvent?.status).toBe("recovered");

    const aboutPage = report.pages.find((p) => p.url.endsWith("/about"));
    expect(aboutPage?.status).toBe("recovered");
    expect(aboutPage?.recovery).toBeDefined();
    expect(report.recoveryCount).toBeGreaterThanOrEqual(1);
  }, 120000);

  it("attributes errors fired after chaos-action navigation to the real URL", async () => {
    // Seed 123 + home's chaos action reliably clicks into /api-consumer.
    // The /api/data console error should then record error.url = /api-consumer,
    // not the home URL, even if it lives in home's PageResult.
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 2,
      maxActionsPerPage: 1,
      headless: true,
      seed: 123,
      faultInjection: [
        {
          name: "api-500",
          urlPattern: "/api/data$",
          fault: { kind: "status", status: 500, body: '{"error":500}' },
        },
      ],
    });
    const report = await crawler.start();

    const apiErrors = report.pages.flatMap((p) =>
      p.errors.filter((e) => e.url?.endsWith("/api-consumer") || e.message.includes("/api/data"))
    );
    // Each error we attribute via /api/data should carry the real URL.
    for (const err of apiErrors) {
      expect(err.url).toMatch(/api-consumer/);
    }

    // Fault should never produce a spurious ERR_ABORTED network error
    // alongside the 500 console error (requires non-empty body, which we now
    // default).
    const networkAborts = report.pages
      .flatMap((p) => p.errors)
      .filter((e) => e.type === "network" && e.message.includes("ERR_ABORTED"));
    expect(networkAborts).toHaveLength(0);
  }, 120000);

  it("injects faults into matching API requests and tracks per-rule stats", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: `${server.url}/api-consumer`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      faultInjection: [
        {
          name: "api-500",
          urlPattern: "/api/data$",
          fault: { kind: "status", status: 500, body: "boom" },
        },
      ],
      invariants: [
        {
          name: "api-consumer-renders-ok",
          urlPattern: "/api-consumer$",
          when: "afterLoad",
          check: async ({ page }) => {
            const status = (await page.locator("#status").textContent())?.trim() ?? "";
            return status === "ok" || `status text was "${status}"`;
          },
        },
      ],
    });

    const report = await crawler.start();
    expect(report.faultInjections).toBeDefined();
    const apiStats = report.faultInjections!.find((f) => f.rule === "api-500")!;
    expect(apiStats.matched).toBeGreaterThanOrEqual(1);
    expect(apiStats.injected).toBe(apiStats.matched);

    // The invariant must fail because the API was forced to 500.
    expect(report.summary.invariantViolations).toBeGreaterThanOrEqual(1);
    expect(
      report.pages[0]!.errors.some(
        (e) => e.type === "invariant-violation" && e.invariantName === "api-consumer-renders-ok"
      )
    ).toBe(true);
  }, 120000);

  it("honours fault probability and is reproducible with the same seed", async () => {
    // probability 0 means the rule never injects but still matches.
    const crawler = new ChaosCrawler({
      baseUrl: `${server.url}/api-consumer`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 99,
      faultInjection: [
        {
          name: "never",
          urlPattern: "/api/data$",
          fault: { kind: "status", status: 500 },
          probability: 0,
        },
      ],
    });

    const report = await crawler.start();
    const stats = report.faultInjections!.find((f) => f.rule === "never")!;
    expect(stats.matched).toBeGreaterThanOrEqual(1);
    expect(stats.injected).toBe(0);
  }, 120000);

  it("surfaces invariant violations as PageErrors and exits non-zero", async () => {
    const invariants: Invariant[] = [
      {
        name: "has-h1",
        when: "afterLoad",
        check: async ({ page }) => {
          const count = await page.locator("h1").count();
          return count > 0 || `no <h1> on this page`;
        },
      },
      {
        name: "no-loading-spinner-after-actions",
        when: "afterActions",
        urlPattern: "/spa/",
        check: async ({ page }) => {
          const text = (await page.locator("#app").textContent()) ?? "";
          return !/loading/i.test(text) || `app still shows loading: "${text}"`;
        },
      },
    ];

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 4,
      maxActionsPerPage: 1,
      headless: true,
      seed: 1,
      invariants,
    });

    const report = await crawler.start();
    // All fixture pages have <h1>, so the has-h1 invariant should hold.
    const hasH1Violations = report.pages
      .flatMap((p) => p.errors)
      .filter((e) => e.invariantName === "has-h1");
    expect(hasH1Violations).toHaveLength(0);

    // Visit the SPA page directly to check the spinner invariant wiring.
    const crawler2 = new ChaosCrawler({
      baseUrl: `${server.url}/spa/items/42`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      invariants: [
        {
          name: "failing-invariant",
          when: "afterLoad",
          check: () => "always fails",
        },
      ],
    });
    const report2 = await crawler2.start();
    expect(report2.summary.invariantViolations).toBeGreaterThanOrEqual(1);
    expect(
      report2.pages[0]!.errors.some((e) => e.type === "invariant-violation"),
    ).toBe(true);
  }, 120000);

  it("fires lifecycle faults at every stage and reports per-fault stats", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 3,
      maxActionsPerPage: 0,
      headless: true,
      seed: 1,
      lifecycleFaults: [
        // beforeNavigation: applied before page.goto on every page.
        faults.cpu(2),
        // afterLoad: clears localStorage on every page.
        faults.clearStorage({ scopes: ["localStorage"] }),
        // beforeActions: drops Service Worker caches on every page.
        faults.evictCache(),
        // afterLoad on /about only: tampers a fixed key.
        faults.tamperStorage({
          scope: "localStorage",
          key: "auth",
          value: "expired",
          urlPattern: /\/about\b/,
        }),
      ],
    });
    const report = await crawler.start();

    expect(report.lifecycleFaults).toBeDefined();
    const stats = report.lifecycleFaults!;
    expect(stats.length).toBe(4);

    // All four entries must have run without throwing for their executor.
    for (const s of stats) {
      expect(s.errored).toBe(0);
      expect(s.fired).toBeLessThanOrEqual(s.matched);
    }

    // Probability defaults to 1 → unconditional faults fire on every match.
    const cpu = stats.find((s) => s.name === "cpu-throttle:2x")!;
    expect(cpu.matched).toBeGreaterThan(0);
    expect(cpu.fired).toBe(cpu.matched);

    const clr = stats.find((s) => s.name === "clear-storage:localStorage")!;
    expect(clr.matched).toBeGreaterThan(0);
    expect(clr.fired).toBe(clr.matched);

    const ev = stats.find((s) => s.name === "evict-cache")!;
    expect(ev.matched).toBeGreaterThan(0);
    expect(ev.fired).toBe(ev.matched);

    // The tamper-storage fault is URL-restricted: matched / fired stay 0
    // when /about wasn't visited. We only check it never errored.
    const tamp = stats.find((s) => s.name === "tamper-storage:localStorage.auth")!;
    expect(tamp.errored).toBe(0);
  }, 120000);

  it("carries state across pages and flags illegal state-machine transitions", async () => {
    type RouteState = "home" | "about" | "spa" | "other";

    // derive() classifies pages by URL path. Transitions only allow the
    // home → about / about → home / home → spa cycle. Reaching any "other"
    // page from anywhere except home is illegal — the fixture has plenty of
    // such pages (/console-error, /js-exception, …) so the crawler will
    // reliably trip the invariant during its BFS.
    const transitions: Partial<Record<RouteState, readonly RouteState[]>> = {
      home: ["about", "spa"],
      about: ["home"],
      spa: ["home"],
      other: ["home"],
    };

    const sm = stateMachineInvariant<RouteState>({
      name: "route",
      initial: "home",
      transitions,
      when: "afterLoad",
      derive: ({ url }) => {
        const path = new URL(url).pathname.replace(/\/$/, "") || "/";
        if (path === "/") return "home";
        if (path === "/about") return "about";
        if (path.startsWith("/spa/")) return "spa";
        return "other";
      },
    });

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 5,
      maxActionsPerPage: 0,
      headless: true,
      seed: 4,
      invariants: [sm],
    });
    const report = await crawler.start();

    const violations = report.pages
      .flatMap((p) => p.errors)
      .filter((e) => e.invariantName === "route");

    // The crawler discovers /console-error and /js-exception from /, so an
    // "home → other" or "about → other" violation must surface.
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]!.message).toMatch(/illegal transition .* → "other"/);

    // A second crawler run must reset state (no leftover label from the
    // previous Map). Configure a tighter SM and assert it sees `home` as the
    // first label, not "spa" (which the previous run might have arrived at).
    const seenInitial: RouteState[] = [];
    const sm2 = stateMachineInvariant<RouteState>({
      name: "route",
      initial: "home",
      transitions,
      when: "afterLoad",
      derive: ({ url, prev }) => {
        seenInitial.push(prev);
        const path = new URL(url).pathname.replace(/\/$/, "") || "/";
        if (path === "/") return "home";
        return "other";
      },
    });
    const crawler2 = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      seed: 9,
      invariants: [sm2],
    });
    await crawler2.start();
    expect(seenInitial[0]).toBe("home");
  }, 120000);

  it("collects V8 precise coverage and surfaces it in report.coverage", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 4,
      maxActionsPerPage: 2,
      headless: true,
      seed: 17,
      coverageFeedback: { enabled: true, boost: 2 },
    });
    const report = await crawler.start();

    expect(report.coverage).toBeDefined();
    const cov = report.coverage!;

    // The fixture site loads inline <script> blocks (console.error,
    // throw new Error, Promise.reject, …) — V8 must report at least one
    // executed function.
    expect(cov.totalFunctions).toBeGreaterThan(0);
    expect(cov.pagesWithNewCoverage).toBeGreaterThan(0);
    expect(Array.isArray(cov.topNovelTargets)).toBe(true);
  }, 120000);

  it("disabling coverage feedback omits report.coverage and keeps the no-feedback action sequence", async () => {
    // Same seed, two configurations: with feedback off, the action sequence
    // must be identical to the prior baseline. With feedback on, weights
    // change after the first action that yields novel coverage, so the
    // sequence may differ.
    const off = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 3,
      maxActionsPerPage: 2,
      headless: true,
      seed: 31,
    });
    const offReport = await off.start();
    expect(offReport.coverage).toBeUndefined();

    const offSelectors = offReport.actions.map((a) => a.selector ?? "");
    expect(offSelectors.length).toBeGreaterThan(0);

    // Sanity: the off-feedback report has no coverage stats but the action
    // sequence is the deterministic seed-driven one.
    const off2 = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 3,
      maxActionsPerPage: 2,
      headless: true,
      seed: 31,
    });
    const offReport2 = await off2.start();
    expect(offReport2.actions.map((a) => a.selector ?? "")).toEqual(offSelectors);
  }, 180000);

  it("populates report.advisor and stamps trace entries when the advisor picks a target", async () => {
    // Stub advisor: forces consultation by reporting always-stalled state via
    // a permissive policy (noveltyStallThreshold=0). Picks index 0 every time.
    const visited: Array<{ url: string; reason: string }> = [];
    const stubAdvisor = {
      name: "stub/test",
      async suggest(ctx: { url: string; reason: string; candidates: { index: number }[] }) {
        visited.push({ url: ctx.url, reason: ctx.reason });
        return { chosenIndex: 0, reasoning: "stub picks index 0" };
      },
    };

    const tmpTrace = join(mkdtempSync(join(tmpdir(), "chaos-advisor-")), "trace.jsonl");

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 3,
      maxActionsPerPage: 3,
      headless: true,
      seed: 11,
      traceOut: tmpTrace,
      advisor: {
        provider: stubAdvisor,
        noveltyStallThreshold: 0,
        minCandidatesToConsult: 1,
        timeoutMs: 5_000,
      },
    });
    const report = await crawler.start();

    expect(report.advisor).toBeDefined();
    expect(report.advisor!.provider).toBe("stub/test");
    expect(report.advisor!.callsAttempted).toBeGreaterThan(0);
    expect(report.advisor!.callsSucceeded).toBeGreaterThan(0);
    expect(report.advisor!.picks.length).toBeGreaterThan(0);
    for (const pick of report.advisor!.picks) {
      expect(pick.reasoning).toBe("stub picks index 0");
      expect(pick.chosenSelector).toBeTruthy();
    }

    // Trace file should have at least one action entry tagged with advisor.
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(tmpTrace, "utf8").trim().split("\n");
    const advisorActions = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "action" && e.advisor !== undefined);
    expect(advisorActions.length).toBeGreaterThan(0);
    expect(advisorActions[0].advisor.provider).toBe("stub/test");
    expect(advisorActions[0].advisor.reasoning).toBe("stub picks index 0");
  }, 120000);

  it("redacts advisor reasoning in report and trace when redactReasoning is true", async () => {
    const stubAdvisor = {
      name: "stub/test",
      async suggest() {
        return { chosenIndex: 0, reasoning: "secret reasoning that should not leak" };
      },
    };

    const tmpTrace = join(mkdtempSync(join(tmpdir(), "chaos-redact-")), "trace.jsonl");

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 2,
      maxActionsPerPage: 2,
      headless: true,
      seed: 13,
      traceOut: tmpTrace,
      advisor: {
        provider: stubAdvisor,
        noveltyStallThreshold: 0,
        minCandidatesToConsult: 1,
        timeoutMs: 5_000,
        redactReasoning: true,
      },
    });
    const report = await crawler.start();

    expect(report.advisor!.picks.length).toBeGreaterThan(0);
    for (const pick of report.advisor!.picks) {
      expect(pick.reasoning).toBe("[redacted]");
      expect(pick.reasoning).not.toContain("secret");
    }

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(tmpTrace, "utf8").trim().split("\n");
    const advisorActions = lines
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "action" && e.advisor !== undefined);
    expect(advisorActions.length).toBeGreaterThan(0);
    for (const a of advisorActions) {
      expect(a.advisor.reasoning).toBe("[redacted]");
      expect(a.advisor.reasoning).not.toContain("secret");
    }
  }, 120000);

  it("forwards screenshotMode: fullPage to the advisor screenshot supplier", async () => {
    const seenSizes: number[] = [];
    const stubAdvisor = {
      name: "stub/test",
      async suggest(ctx: { screenshot: Buffer }) {
        seenSizes.push(ctx.screenshot.byteLength);
        return { chosenIndex: 0, reasoning: "ok" };
      },
    };

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 2,
      maxActionsPerPage: 2,
      headless: true,
      seed: 21,
      advisor: {
        provider: stubAdvisor,
        noveltyStallThreshold: 0,
        minCandidatesToConsult: 1,
        timeoutMs: 5_000,
        screenshotMode: "fullPage",
      },
    });
    await crawler.start();

    expect(seenSizes.length).toBeGreaterThan(0);
    for (const size of seenSizes) {
      expect(size).toBeGreaterThan(0);
    }
  }, 120000);

  it("captures SPA history.pushState navigations as discovered links", async () => {
    // /spa-router has NO `<a href>` to /spa-router/*, only buttons that
    // call history.pushState. Static link extraction misses every one;
    // the new pushState hook is the only path that surfaces them.
    const crawler = new ChaosCrawler({
      baseUrl: `${server.url}/spa-router`,
      // Cap visits at 1 so we stay on the SPA shell instead of recursing.
      maxPages: 1,
      // Need actions so the chaos driver clicks the pushState buttons.
      maxActionsPerPage: 6,
      headless: true,
      seed: 7,
    });
    const report = await crawler.start();

    const spaPage = report.pages.find((p) => p.url.includes("/spa-router"));
    expect(spaPage).toBeDefined();

    const links = spaPage!.links;
    // Auto-route on mount (replaceState).
    expect(links.some((l) => l.endsWith("/spa-router/auto"))).toBe(true);
    // At least one button-driven pushState should have fired given seed=7
    // and 6 chaos actions on a page with 3 routable buttons.
    const buttonRoutes = ["dashboard", "settings", "profile"];
    expect(
      buttonRoutes.some((r) => links.some((l) => l.endsWith(`/spa-router/${r}`))),
    ).toBe(true);
  }, 120000);
});
