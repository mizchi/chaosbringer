import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { perfSeekingDriver } from "./drivers/perf-seeking.js";
import type { Driver, DriverStep } from "./drivers/types.js";
import { weightedRandomDriver } from "./drivers/weighted-random.js";
import type { CrawlerOptions, CrawlReport, LastActionPerf } from "./types.js";

/**
 * The model-seam perf facts and the perf-seeking driver, end to end: a page
 * of buttons where one click handler spins the main thread and the rest do
 * nothing. Only a browser makes that spin a long task and the click an
 * interaction, which is what the driver weighs.
 */

/** How long the slow button's handler blocks, in wall-clock ms. */
const SLOW_MS = 150;

const BUTTONS = `<!doctype html><title>buttons</title><body>
  <button id="fast1">Fast one</button>
  <button id="fast2">Fast two</button>
  <button id="slow">Slow</button>
  <button id="fast3">Fast three</button>
  <button id="fast4">Fast four</button>
  <script>
    document.getElementById("slow").addEventListener("click", () => {
      const t0 = performance.now();
      while (performance.now() - t0 < ${SLOW_MS}) {}
    });
  </script>
</body>`;

/** The crawler keys buttons by their text, so the slow one's selector says "Slow". */
const isSlow = (a: { selector?: string }) => a.selector?.includes("Slow") === true;

/** Records the `lastActionPerf` each step carried, then defers to `inner`. */
function recording(inner: Driver): {
  driver: Driver;
  seen: Array<LastActionPerf | undefined>;
  present: boolean[];
} {
  const seen: Array<LastActionPerf | undefined> = [];
  const present: boolean[] = [];
  return {
    seen,
    present,
    driver: {
      name: `recording(${inner.name})`,
      async selectAction(step: DriverStep) {
        seen.push(step.lastActionPerf);
        present.push("lastActionPerf" in step);
        return inner.selectAction(step);
      },
    },
  };
}

describe("perf facts at the driver seam, and perfSeekingDriver", () => {
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(BUTTONS);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const crawl = (extra: Partial<CrawlerOptions>): Promise<CrawlReport> =>
    new ChaosCrawler({
      baseUrl: `${origin}/buttons`,
      maxPages: 1,
      maxActionsPerPage: 24,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      seed: 7,
      ...extra,
    }).start();

  const slowClicks = (report: CrawlReport) =>
    report.actions.filter((a) => a.type === "click" && isSlow(a)).length;

  it("hands each step the previous action's span, absent on the first step", async () => {
    // Round-robin over the candidates, so the slow button is clicked.
    const roundRobin: Driver = {
      name: "round-robin",
      async selectAction(step) {
        return { kind: "select", index: step.stepIndex % step.candidates.length };
      },
    };
    const { driver, seen } = recording(roundRobin);
    const report = await crawl({ perf: true, driver, maxActionsPerPage: 6 });
    expect(report.actions.length).toBe(6);
    expect(seen[0]).toBeUndefined();
    // Every later step's facts are the previous action's span, under the
    // key the report gives it. Compared by key: the report's figures are
    // read at page end, the step's as of the step.
    for (let i = 1; i < report.actions.length; i++) {
      expect(seen[i]?.key).toBe(report.actions[i - 1]!.perf?.key);
    }
    const afterSlow = seen.filter((p, i) => i > 0 && isSlow(report.actions[i - 1]!));
    expect(afterSlow.length).toBeGreaterThan(0);
    for (const p of afterSlow) {
      // A lower bound from fixed wall-clock work; a loaded machine can only
      // stretch it. Never longer than the span it is part of.
      expect(p!.cpu.blockingMs).toBeGreaterThanOrEqual(SLOW_MS - 30);
      expect(p!.cpu.blockingMs).toBeLessThanOrEqual(p!.durationMs);
    }
  }, 60_000);

  it("leaves the field absent when perf is off", async () => {
    const { driver, present } = recording(weightedRandomDriver());
    const report = await crawl({ driver, maxActionsPerPage: 4 });
    expect(report.actions.length).toBe(4);
    // Absent, not present-and-undefined.
    expect(present).toEqual([false, false, false, false]);
  }, 60_000);

  it("clicks the slow button more often than weightedRandomDriver with the same seed", async () => {
    const random = await crawl({ perf: true, driver: weightedRandomDriver() });
    const warnings: string[] = [];
    const seeking = await crawl({ perf: true, driver: perfSeekingDriver({ onWarn: (m) => warnings.push(m) }) });
    expect(random.actions.length).toBe(24);
    expect(seeking.actions.length).toBe(24);
    expect(warnings).toEqual([]);
    const r = slowClicks(random);
    const s = slowClicks(seeking);
    // The claim, and the only bound that holds on a loaded machine: load can
    // add long tasks to a fast click and blur the costs, but the slow click
    // always blocks for SLOW_MS of wall time, so it stays the costliest key.
    // (On an idle machine this reads about 16 against 6.)
    expect(s).toBeGreaterThan(r);
  }, 60_000);

  it("warns and picks uniformly when perf is off", async () => {
    const warnings: string[] = [];
    const report = await crawl({
      driver: perfSeekingDriver({ onWarn: (m) => warnings.push(m) }),
      maxActionsPerPage: 6,
    });
    expect(report.actions.length).toBe(6);
    expect(warnings).toHaveLength(1);
  }, 60_000);
});
