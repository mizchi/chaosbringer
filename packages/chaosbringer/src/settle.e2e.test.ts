import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/site/server.js";
import { ChaosCrawler } from "./crawler.js";
import type { Driver, DriverPick, DriverStep } from "./drivers/types.js";
import { faults } from "./faults.js";
import type { CrawlerOptions, CrawlReport } from "./types.js";

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
  let server: http.Server;
  let origin: string;
  /** When `/api/slow` answered, by wall clock. */
  let slowAnsweredAt: number[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/xhr" || url.pathname === "/hang") {
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        res.end(url.pathname === "/xhr" ? XHR_PAGE : HANG_PAGE);
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
      maxPages: 1,
      maxActionsPerPage: 3,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
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
      logLevel: "silent",
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
