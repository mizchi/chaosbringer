import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faults } from "@mizchi/playwright-faults";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";
import { formatReport } from "./reporter.js";
import type { CrawlerOptions, CrawlReport } from "./types.js";

/**
 * Perf under chaos, end to end: spans tagged with the faults active in their
 * window, the degradation those faults caused, and a leak found by a step
 * the crawl repeats. A real browser, because a delay only costs a span
 * wall-clock time when a real request waits on it, and a listener count only
 * climbs in a real renderer.
 */

const ITEM_COUNT = 8;

/** Links to every item page, so one crawl visits them all. */
const SHOP = `<!doctype html><title>shop</title><body>
  <h1>Shop</h1>
  ${Array.from({ length: ITEM_COUNT }, (_, i) => `<a href="/item/${i + 1}">Item ${i + 1}</a>`).join("\n  ")}
</body>`;

/** An item page whose load fetches its data from the API. */
const ITEM = `<!doctype html><title>item</title><body>
  <h1 id="name">loading</h1>
  <script>
    fetch("/api/item").then((r) => r.json()).then((d) => {
      document.getElementById("name").textContent = d.name;
    });
  </script>
</body>`;

/**
 * A client-side nav button that leaks: every click pushes a history entry
 * and adds listeners to the document that are never removed, the classic
 * "subscribe on route change, forget to unsubscribe".
 */
const LEAKY = `<!doctype html><title>leaky</title><body>
  <button id="nav">Nav</button>
  <script>
    let n = 0;
    document.getElementById("nav").addEventListener("click", () => {
      n++;
      history.pushState({}, "", "/leaky?view=" + n);
      for (let i = 0; i < 5; i++) document.addEventListener("scroll", () => void n);
    });
  </script>
</body>`;

/**
 * Two inline scripts: the first runs all of its code, the second only
 * defines a function nobody calls. Chromium reports both under the page's
 * URL, each with offsets from 0. The first is the longer one, so laying the
 * second's ranges over it (the bug) read the page as 100% used.
 */
const COV_INLINE = `<!doctype html><title>cov inline</title><body>
  <script>
    var total = 0;
    for (var i = 0; i < 10; i++) { total += i * 2; }
    document.title = "sum " + total + "${"padding ".repeat(60)}".length;
  </script>
  <script>
    function neverCalled(x) {
      var out = [];
      for (var i = 0; i < x; i++) { out.push(i * i); if (out.length > 100) { out.shift(); } }
      return out.reduce(function (a, b) { return a + b; }, 0) + "${"padding ".repeat(40)}";
    }
  </script>
</body>`;

/**
 * The E4 xhr-site shape (B2): a button whose click fires a fetch nobody
 * awaits. Under the default `networkidle` settle the click's span closes a
 * few ms after the fetch starts, so a delay on that fetch is not in the
 * span's `durationMs`.
 */
const XHR = `<!doctype html><title>xhr</title><body>
  <p id="status">idle</p>
  <button type="button" id="reload">Reload</button>
  <script>
    document.getElementById("reload").addEventListener("click", () => {
      fetch("/api/x").then((r) => r.json()).then((d) => {
        document.getElementById("status").textContent = d.ok ? "ok" : "bad";
      });
    });
  </script>
</body>`;

/** Picks the candidate whose description contains `label`, `times` times, then skips. */
function repeatDriver(label: string, times: number): Driver {
  let i = 0;
  return {
    name: "repeat",
    onPageStart() {
      i = 0;
    },
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      if (i++ >= times) return { kind: "skip" };
      const c = step.candidates.find((x) => x.description.includes(label));
      return c ? { kind: "select", index: c.index } : { kind: "skip" };
    },
  };
}

describe("perf under chaos", () => {
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/item" || path === "/api/x") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ name: "widget" }));
        return;
      }
      const body =
        path === "/shop" ? SHOP : /^\/item\/\d+$/.test(path ?? "") ? ITEM : path === "/leaky" ? LEAKY : path === "/cov-inline" ? COV_INLINE : path === "/xhr" ? XHR : null;
      if (!body) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function crawl(path: string, extra: Partial<CrawlerOptions>): Promise<CrawlReport> {
    return new ChaosCrawler({
      baseUrl: `${origin}${path}`,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      seed: 7,
      perf: true,
      ...extra,
    }).start();
  }

  it("tags the delayed loads and reports what the delay cost the item route", async () => {
    const report = await crawl("/shop", {
      maxPages: ITEM_COUNT + 1,
      maxActionsPerPage: 0,
      faultInjection: [
        faults.delay(300, { urlPattern: /\/api\/item$/, probability: 0.5, name: "api-delay" }),
      ],
    });

    const items = report.pages.filter((p) => /\/item\/\d+$/.test(p.url));
    expect(items).toHaveLength(ITEM_COUNT);
    for (const p of items) expect(p.perf?.key).toBe("/item/:id :: load");

    // Each item load makes exactly one API request, inside its load span, so
    // the spans tagged with the fault are exactly the times it fired.
    const tagged = items.filter((p) => p.perf?.faults?.includes("api-delay"));
    const fired = report.faultInjections?.find((f) => f.rule === "api-delay")?.injected;
    expect(tagged.length).toBe(fired);
    // The seed gives both sides, which is what a comparison needs.
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.length).toBeLessThan(ITEM_COUNT);
    // The shop page made no API request: nothing to tag.
    expect(report.pages.find((p) => p.url.endsWith("/shop"))?.perf?.faults).toBeUndefined();

    const row = report.perf?.degradation?.find(
      (d) => d.key === "/item/:id :: load" && d.fault === "api-delay",
    );
    expect(row).toBeDefined();
    expect(row!.faulted.n).toBe(tagged.length);
    expect(row!.clean.n).toBe(ITEM_COUNT - tagged.length);
    // Lower bound from fixed wall-clock work: every faulted load waited 300 ms
    // for its API response inside the span, whatever the machine's load. The
    // delta is only asserted positive; a loaded machine can slow the clean
    // loads too, so how much of the 300 ms survives is not fixed.
    expect(row!.faulted.durationMs).toBeGreaterThanOrEqual(300);
    expect(row!.delta.durationMs).toBeGreaterThan(0);

    const text = formatReport(report);
    expect(text).toContain("Degradation under faults (median with vs without):");
    expect(text).toMatch(/\/item\/:id :: load {2}under api-delay/);
    // Nine pages, each settling on `networkidle`: seconds, not the default 5.
  }, 60_000);

  // B2 follow-up (2026-09-24 evaluation, E4 xhr-site): the delayed fetch's
  // 300 ms never reached the click's durationMs, so the degradation entry
  // read slightly negative. `effectiveMs` counts until the click's own
  // request finished — including the last click, whose fetch outlives the
  // page's last step and is waited for when the report is built.
  it("reports a delay on a fetch a click fired but did not wait for in effectiveMs", async () => {
    const clicks = 8;
    const report = await crawl("/xhr", {
      maxPages: 1,
      maxActionsPerPage: clicks,
      driver: repeatDriver("Reload", clicks),
      faultInjection: [faults.delay(300, { urlPattern: /\/api\/x$/, probability: 0.5, name: "api-delay-300" })],
    });
    expect(report.perf?.settle?.mode ?? "networkidle").toBe("networkidle");
    expect(report.actions).toHaveLength(clicks);
    const key = report.actions[0]!.perf!.key;
    expect(key).toMatch(/^\/xhr :: click .*Reload/);
    const spans = report.actions.map((a) => a.perf!);
    for (const s of spans) {
      expect(s.key).toBe(key);
      // each click fired its own fetch, and every one was over by report time
      expect(s.network.requestCount).toBe(1);
      expect(s.network.settledUnfinished).toBeUndefined();
      expect(s.network.settledMs).toBeGreaterThan(0);
    }
    const hit = spans.filter((s) => s.faults?.includes("api-delay-300"));
    expect(hit.length).toBe(report.faultInjections?.find((f) => f.rule === "api-delay-300")?.injected);
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.length).toBeLessThan(clicks);
    // networkidle did not wait: every delayed click closed before its fetch
    // answered, which ran at least the 300 ms delay past its start.
    for (const s of hit) {
      expect(s.network.settledMs!).toBeGreaterThan(s.durationMs);
      expect(s.network.settledMs!).toBeGreaterThanOrEqual(300);
    }

    const row = report.perf?.degradation?.find((d) => d.key === key && d.fault === "api-delay-300");
    expect(row).toBeDefined();
    expect(row!.faulted.n).toBe(hit.length);
    expect(row!.faulted.effectiveMs).toBeGreaterThanOrEqual(300);
    expect(row!.delta.effectiveMs).toBeGreaterThanOrEqual(250);
    // the span's own wall time did not carry the delay
    expect(row!.delta.durationMs).toBeLessThan(150);
    expect(row!.delta.effectiveMs - row!.delta.durationMs).toBeGreaterThanOrEqual(200);

    expect(formatReport(report)).toMatch(/under api-delay-300 .*span [+-]\d+ms/);
  }, 60_000);

  it("flags listeners climbing across a repeated nav click, and tags page-wide faults", async () => {
    const clicks = 8;
    const report = await crawl("/leaky", {
      maxPages: 1,
      maxActionsPerPage: clicks,
      driver: repeatDriver("Nav", clicks),
      lifecycleFaults: [faults.cpu(2, { name: "cpu-2x" })],
      runtimeFaults: [faults.clockSkew(60_000, { name: "skew" })],
    });

    expect(report.actions).toHaveLength(clicks);
    const key = report.actions[0]!.perf?.key;
    expect(key).toMatch(/^\/leaky :: click /);
    for (const a of report.actions) expect(a.perf?.key).toBe(key);

    // The throttle fired before the load and lasts the visit; the runtime
    // fault is on every page. Both tag every span of the page.
    const spans = [report.pages[0]!.perf!, ...report.actions.map((a) => a.perf!)];
    for (const s of spans) expect(s.faults).toEqual(["cpu-2x", "skew"]);

    const trend = report.perf?.trends?.find((t) => t.name === key && t.metric === "jsEventListeners");
    expect(trend).toBeDefined();
    expect(trend!.leak).toBe(true);
    expect(trend!.count).toBe(clicks);
    // 5 listeners a click, never removed: the climb is at least that much per
    // repeat (the page may add its own on top, it never takes these away).
    expect(trend!.perStep).toBeGreaterThanOrEqual(5);

    expect(formatReport(report)).toContain("Memory climbing across repeats of a step (likely leak):");
  }, 60_000);

  it("unions coverage over every page the crawl visited", async () => {
    const report = await crawl("/shop", {
      maxPages: 3,
      maxActionsPerPage: 0,
      perf: { coverage: true },
    });
    const js = report.perf?.coverage?.js;
    expect(js).toBeDefined();
    expect(js!.totalBytes).toBeGreaterThan(0);
    expect(js!.usedBytes).toBeGreaterThan(0);
    expect(js!.usedBytes).toBeLessThanOrEqual(js!.totalBytes);
    // The item pages' scripts run end to end; fully used resources are not
    // "low usage", so only rows with unused bytes may appear (B19).
    for (const r of js!.lowUsage) expect(r.usedBytes).toBeLessThan(r.totalBytes);
    // One row per resource across the crawl, not one per page visit.
    const urls = js!.lowUsage.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(report.perf?.coverage?.css.totalBytes).toBe(0);
    // No stylesheet anywhere: no percentage rather than a misleading 0% (B19).
    expect(report.perf?.coverage?.css.usedPct).toBeUndefined();
  }, 60_000);

  // B4: the two inline scripts used to be merged into one entry whose ranges
  // lay over each other, and the page read 100% used.
  it("keeps a page's inline scripts apart in the coverage", async () => {
    const report = await crawl("/cov-inline", {
      maxPages: 1,
      maxActionsPerPage: 0,
      perf: { coverage: true },
    });
    const js = report.perf?.coverage?.js;
    expect(js).toBeDefined();
    expect(js!.usedPct).toBeLessThan(80);
    const second = js!.lowUsage.find((r) => r.url === `${origin}/cov-inline#inline-2`);
    expect(second).toBeDefined();
    expect(second!.usedPct).toBeLessThan(30);
    // the first script ran end to end, so it is not low usage
    expect(js!.lowUsage.map((r) => r.url)).not.toContain(`${origin}/cov-inline`);
  }, 60_000);
});
