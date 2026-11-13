import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/site/server.js";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";
import { faults } from "./faults.js";
import type { CrawlerOptions, CrawlReport, Invariant } from "./types.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * Adaptive settle against a real browser.
 *
 * `/xhr?ms=N`: clicking "Load" fetches `/api/slow?ms=N`, which answers after
 * N ms, and only then renders a "Rendered" button. Whether the step after
 * the click can see that button is exactly the question a settle answers.
 *
 * `/hang`: clicking "Hang" fetches `/api/never`, which the server never
 * answers; "Noop" does nothing. Clicking "Hang" through a `hang` fault
 * instead parks the route in the crawler's held-route registry.
 *
 * `/busy`, `/midsettle` and `/chain` hold the settle open with long tasks
 * alone, each run with perf off and on: with perf on, the session's emit
 * binding moves every task out of the collector's `longTasks` as soon as it
 * is observed, and the long-task gate used to read that array. `/busy` under
 * the default 30 s timeout and `/burst` (busy for 3 s, then quiet) pin the
 * never-idle early stop: the first stops after the 5 s streak, the second
 * still waits for its last task.
 *
 * Timing assertions are lower bounds from fixed wall-clock work (the server's
 * delay, the cap), never tight upper bounds: this suite runs on loaded CI.
 */
const XHR_PAGE = `<!doctype html><title>xhr</title><body>
  <button id="load">Load</button>
  <script>
    document.getElementById("load").addEventListener("click", () => {
      const ms = new URLSearchParams(location.search).get("ms") || "300";
      fetch("/api/slow?ms=" + ms).then((r) => r.text()).then(() => {
        const b = document.createElement("button");
        b.id = "rendered";
        b.textContent = "Rendered";
        document.body.appendChild(b);
      });
    });
  </script>
</body>`;

const HANG_PAGE = `<!doctype html><title>hang</title><body>
  <button id="hang">Hang</button>
  <button id="noop">Noop</button>
  <script>
    document.getElementById("hang").addEventListener("click", () => {
      fetch("/api/never").catch(() => {});
    });
  </script>
</body>`;

/** A 70 ms long task every 90 ms, forever: the main thread never goes quiet. */
const BUSY_PAGE = `<!doctype html><title>busy</title><body>
  <h1>Always busy</h1>
  <script>
    setInterval(() => { const t0 = performance.now(); while (performance.now() - t0 < 70) {} }, 90);
  </script>
</body>`;

/**
 * After load, a request answering 100 ms later, and a 70 ms long task 120 ms
 * after load: the task ends while the settle waits out the network quiet
 * window, so only the long-task gate keeps the settle open past it.
 */
const MIDSETTLE_PAGE = `<!doctype html><title>midsettle</title><body>
  <h1>A heading large enough to be the LCP element</h1>
  <script>
    addEventListener("load", () => {
      fetch("/api/slow?ms=100").then((r) => r.text());
      setTimeout(() => { const t0 = performance.now(); while (performance.now() - t0 < 70) {} window.__taskEnd = performance.now(); }, 120);
    });
  </script>
</body>`;

const BUSY_HUNG_PAGE = `<!doctype html><title>busy-hung</title><body>
  <h1>Always busy, and waiting</h1>
  <script>
    fetch("/api/never").catch(() => {});
    setInterval(() => { const t0 = performance.now(); while (performance.now() - t0 < 70) {} }, 90);
  </script>
</body>`;

/**
 * A 60 ms long task every 90 ms for 3 s after load, then nothing: busy for
 * less than the never-idle streak, so the load still waits it out.
 */
const BURST_PAGE = `<!doctype html><title>burst</title><body>
  <h1>Busy, then quiet</h1>
  <script>
    addEventListener("load", () => {
      const until = performance.now() + 3000;
      const id = setInterval(() => {
        const t0 = performance.now(); while (performance.now() - t0 < 60) {}
        window.__taskEnd = performance.now();
        if (performance.now() >= until) clearInterval(id);
      }, 90);
    });
  </script>
</body>`;

/** "Run work" runs a 60 ms task, then 40 ms later a 120 ms one: a gap shorter than the quiet window. */
const CHAIN_PAGE = `<!doctype html><title>chain</title><body>
  <button id="run">Run work</button>
  <script>
    document.getElementById("run").addEventListener("click", () => {
      let t0 = performance.now(); while (performance.now() - t0 < 60) {}
      setTimeout(() => { const t1 = performance.now(); while (performance.now() - t1 < 120) {} window.__taskEnd = performance.now(); }, 40);
    });
  </script>
</body>`;

/**
 * An invariant that records how long after the page's last long task
 * (`window.__taskEnd`) it ran. `afterLoad` invariants run once the load has
 * settled, `afterActions` once the last action has.
 */
function gapSince(when: "afterLoad" | "afterActions", gaps: number[]): Invariant {
  return {
    name: "gap",
    when,
    async check({ page }) {
      gaps.push(await page.evaluate(() => performance.now() - (window as unknown as { __taskEnd: number }).__taskEnd));
      return true;
    },
  };
}

/** Click the candidates whose description contains each text, in order; record what step N saw. */
function clickInOrder(texts: string[], seen: string[][]): Driver {
  return {
    name: "click-in-order",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      seen.push(step.candidates.map((c) => c.description));
      const text = texts[step.stepIndex];
      if (text === undefined) return { kind: "skip" };
      const c = step.candidates.find((x) => x.description.includes(text));
      return c ? { kind: "select", index: c.index } : { kind: "skip" };
    },
  };
}

describe("adaptive settle (e2e)", () => {
  let server: TestServer;
  let origin: string;
  /** When `/api/slow` answered, by wall clock. */
  let slowAnsweredAt: number[] = [];

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const pages: Record<string, string> = { "/xhr": XHR_PAGE, "/hang": HANG_PAGE, "/busy": BUSY_PAGE, "/midsettle": MIDSETTLE_PAGE, "/chain": CHAIN_PAGE, "/burst": BURST_PAGE, "/busy-hung": BUSY_HUNG_PAGE };
      if (pages[url.pathname]) {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        res.end(pages[url.pathname]);
        return;
      }
      if (url.pathname === "/api/slow") {
        const ms = Number(url.searchParams.get("ms") ?? "300");
        setTimeout(() => {
          slowAnsweredAt.push(Date.now());
          res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
          res.end("ok");
        }, ms);
        return;
      }
      if (url.pathname === "/api/never") return; // never answered
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    origin = server.url;
  });

  afterAll(async () => {
    await server.close();
  });

  function crawl(path: string, extra: Partial<CrawlerOptions>): Promise<CrawlReport> {
    return new ChaosCrawler({
      baseUrl: `${origin}${path}`,
      maxPages: 1,
      maxActionsPerPage: 3,
      headless: true,
      timeout: 10_000,
      logLevel: "error",
      seed: 1,
      ...extra,
    }).start();
  }

  it("adaptive: the step after a click sees what the click's XHR rendered", async () => {
    slowAnsweredAt = [];
    const seen: string[][] = [];
    const report = await crawl("/xhr?ms=300", {
      settle: "adaptive",
      perf: true,
      driver: clickInOrder(["Load"], seen),
    });
    const click = report.actions[0]!;
    expect(click.success).toBe(true);
    // The step after the click was chosen from a list that has the button.
    expect(seen[1]!.some((d) => d.includes("Rendered"))).toBe(true);
    // The click's span waited for the server's fixed 300 ms, and did not cap.
    expect(click.perf!.durationMs).toBeGreaterThanOrEqual(300);
    expect(click.perf!.capped).toBe(false);
    expect(report.pages[0]!.settleCapped).toBe(0);
    expect(slowAnsweredAt).toHaveLength(1);
    // Recorded in the report (B5): `perf regress` refuses to compare these
    // spans with a networkidle crawl's, whose action spans exclude the settle.
    expect(report.perf?.settle).toEqual({ mode: "adaptive", quietMs: 100 });
  }, 60_000);

  it.each([false, true])("adaptive: back-to-back long tasks cap the load (perf %s)", async (perf) => {
    // The long-task gate reads the collector's `lastLongTaskEnd`. With perf on,
    // the session's emit binding empties `longTasks` at every observer
    // callback, so a gate reading that saw no task and settled at once.
    const report = await crawl("/busy", { settle: "adaptive", perf, maxActionsPerPage: 0, timeout: 3_000 });
    const page = report.pages[0]!;
    expect(page.settleCapped).toBe(1);
    // The capped settle is part of the load, so TBT counts its tasks too.
    expect(page.metrics?.tbt).toBeGreaterThan(200);
    if (perf) expect(page.perf!.capped).toBe(true);
  }, 60_000);

  it.each([false, true])("adaptive: a never-idle load stops at the never-idle streak, not the 30 s timeout (perf %s)", async (perf) => {
    const report = await crawl("/busy", { settle: "adaptive", perf, maxActionsPerPage: 0, timeout: 30_000 });
    const page = report.pages[0]!;
    expect(page.status).toBe("success");
    expect(page.settleCapped).toBe(1);
    // Waited out the 5 s streak; nowhere near the 30 s navigation timeout.
    expect(page.loadTime).toBeGreaterThanOrEqual(5_000);
    expect(page.loadTime).toBeLessThan(15_000);
    expect(page.metrics?.tbt).toBeGreaterThan(200);
    if (perf) {
      expect(page.perf!.capped).toBe(true);
      expect(page.perf!.durationMs).toBeGreaterThanOrEqual(5_000);
    }
  }, 60_000);

  it("adaptive: a never-idle load with a request in flight still waits up to the timeout", async () => {
    const report = await crawl("/busy-hung", { settle: "adaptive", perf: true, maxActionsPerPage: 0, timeout: 9000 });
    const page = report.pages[0]!;
    expect(page.settleCapped).toBe(1);
    expect(page.perf!.capped).toBe(true);
    // The hung request holds the load past the 5 s never-idle streak, to the timeout.
    expect(page.perf!.durationMs).toBeGreaterThanOrEqual(8000);
  }, 60_000);

  it.each([false, true])("adaptive: a load that is busy for 3 s, then quiet, still settles after its last task (perf %s)", async (perf) => {
    const gaps: number[] = [];
    const report = await crawl("/burst", { settle: "adaptive", perf, maxActionsPerPage: 0, timeout: 30_000, invariants: [gapSince("afterLoad", gaps)] });
    const page = report.pages[0]!;
    expect(page.settleCapped).toBe(0);
    expect(gaps[0]).toBeGreaterThanOrEqual(95);
    expect(page.loadTime).toBeGreaterThanOrEqual(3_000);
    if (perf) expect(page.perf!.capped).toBe(false);
  }, 60_000);

  it.each([false, true])("adaptive: the load waits out the quiet window after a long task that ends mid-settle (perf %s)", async (perf) => {
    const gaps: number[] = [];
    const report = await crawl("/midsettle", { settle: "adaptive", perf, maxActionsPerPage: 0, invariants: [gapSince("afterLoad", gaps)] });
    const page = report.pages[0]!;
    expect(page.settleCapped).toBe(0);
    // The settle ended at least the quiet window (100 ms) after the task.
    expect(gaps[0]).toBeGreaterThanOrEqual(95);
    expect(page.metrics?.tbt).toBeGreaterThan(0);
    if (perf) expect(page.perf!.cpu.longTaskCount).toBe(1);
  }, 60_000);

  it.each([false, true])("adaptive: a click's span holds both of its chained long tasks (perf %s)", async (perf) => {
    const gaps: number[] = [];
    const report = await crawl("/chain", {
      settle: "adaptive",
      perf,
      maxActionsPerPage: 1,
      driver: clickInOrder(["Run work"], []),
      invariants: [gapSince("afterActions", gaps)],
    });
    const click = report.actions[0]!;
    expect(click.success).toBe(true);
    expect(gaps[0]).toBeGreaterThanOrEqual(95);
    if (perf) {
      expect(click.perf!.cpu.longTaskCount).toBe(2);
      expect(click.perf!.cpu.blockingMs).toBeGreaterThanOrEqual(170);
      expect(click.perf!.capped).toBe(false);
    }
  }, 60_000);

  it("networkidle (default): the post-click wait does not wait for the XHR", async () => {
    // Documents today's behaviour rather than asserting it is right:
    // `waitForLoadState("networkidle")` resolves at once on a document that
    // already reached networkidle, so the next step starts well before a
    // 1500 ms XHR answers and cannot see what it renders.
    slowAnsweredAt = [];
    const seen: string[][] = [];
    const stepAt: number[] = [];
    const driver = clickInOrder(["Load"], seen);
    const select = driver.selectAction.bind(driver);
    driver.selectAction = (step) => {
      stepAt.push(Date.now());
      return select(step);
    };
    const report = await crawl("/xhr?ms=1500", { driver });
    expect(report.actions[0]!.success).toBe(true);
    expect(seen[1]!.some((d) => d.includes("Rendered"))).toBe(false);
    // Invariant, not a timing guess: the next step began before the XHR's
    // answer was even sent (or the XHR never answered before the page ended).
    const answered = slowAnsweredAt[0] ?? Number.POSITIVE_INFINITY;
    expect(stepAt[1]!).toBeLessThan(answered);
    // Nothing to count under networkidle.
    expect(report.pages[0]!.settleCapped).toBeUndefined();
    expect(report.actions[0]!.perf).toBeUndefined();
  }, 60_000);

  it("adaptive: a request that never ends caps that step, and only that step", async () => {
    const seen: string[][] = [];
    const report = await crawl("/hang", {
      settle: "adaptive",
      perf: true,
      driver: clickInOrder(["Hang", "Noop"], seen),
    });
    const [hang, noop] = report.actions;
    expect(hang!.success).toBe(true);
    expect(hang!.perf!.capped).toBe(true);
    // The cap is 2000 ms from the click; the span started before it.
    expect(hang!.perf!.durationMs).toBeGreaterThanOrEqual(1900);
    // The hung request has outlived the cap, so it no longer holds the page.
    expect(noop!.success).toBe(true);
    expect(noop!.perf!.capped).toBe(false);
    expect(report.pages[0]!.settleCapped).toBe(1);
    expect(report.pages[0]!.perf!.capped).toBe(false);
  }, 60_000);

  it("adaptive: a hang fault's parked route caps at the cap and is still drained", async () => {
    const seen: string[][] = [];
    const started = Date.now();
    const report = await crawl("/hang", {
      settle: "adaptive",
      driver: clickInOrder(["Hang", "Noop"], seen),
      faultInjection: [faults.hang({ urlPattern: "/api/never" })],
    });
    expect(report.actions).toHaveLength(2);
    expect(report.pages[0]!.settleCapped).toBe(1);
    expect(report.heldRequests).toBe(1);
    // One capped step, never the page's navigation timeout (10 s) per step.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(report.pages[0]!.status).toBe("success");
  }, 60_000);
});

describe("adaptive settle parity with networkidle (fixture site)", () => {
  let site: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    site = await startFixtureServer(0);
  });
  afterAll(async () => {
    await site.close();
  });

  async function run(settle: CrawlerOptions["settle"]): Promise<{ report: CrawlReport; ms: number }> {
    const started = Date.now();
    const report = await new ChaosCrawler({
      baseUrl: site.url,
      maxPages: 10,
      headless: true,
      logLevel: "error",
      seed: 42,
      settle,
    }).start();
    return { report, ms: Date.now() - started };
  }

  it("same seed → same visited pages and the same error fingerprints", async () => {
    const idle = await run("networkidle");
    const adaptive = await run("adaptive");
    const pages = (r: CrawlReport) => r.pages.map((p) => p.url).sort();
    const fingerprints = (r: CrawlReport) => r.errorClusters.map((c) => c.key).sort();
    expect(pages(adaptive.report)).toEqual(pages(idle.report));
    expect(fingerprints(adaptive.report)).toEqual(fingerprints(idle.report));
    expect(pages(idle.report).length).toBeGreaterThan(1);
    // Reported, not asserted: wall clock depends on the machine.
    console.info(
      `[settle parity] networkidle ${idle.ms} ms, adaptive ${adaptive.ms} ms, ` +
        `${idle.report.pages.length} pages, ${idle.report.errorClusters.length} clusters`,
    );
  }, 180_000);
});
