import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faults } from "../faults.js";
import { defineScenario } from "./scenario.js";
import { scenarioLoad } from "./scenario-load.js";
import { formatLoadReport } from "./report.js";
import { assertSlo } from "./slo.js";

/**
 * `scenarioLoad({ perf })` end to end: a sampled worker measures each step as
 * a lightbringer span while an unmeasured one shares the load. Follows the
 * fixture-site smoke (`fixtures/runner/scenario-load.e2e.test.ts`) but serves
 * its own page, because the assertion needs a known long task: the click
 * handler spins for 120 ms, so the click step's blocking has a lower bound
 * that holds however loaded the machine is.
 */
const BUSY = `<!doctype html><title>busy</title><body>
  <button id="busy">Busy</button>
  <script>
    document.getElementById("busy").addEventListener("click", () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 120) {}
      document.body.dataset.clicked = String(Number(document.body.dataset.clicked || 0) + 1);
    });
  </script>
</body>`;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(BUSY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("scenarioLoad with perf", () => {
  it("rejects trace level before launching anything", async () => {
    await expect(
      scenarioLoad({
        baseUrl: "http://127.0.0.1:1",
        scenarios: [{ scenario: defineScenario({ name: "x", steps: [{ name: "s", run: async () => {} }] }), workers: 1 }],
        perf: { level: "trace" } as never,
      }),
    ).rejects.toThrow(/only "light"/);
  });

  it("installs the collector ahead of a clock-skew runtime fault", async () => {
    const scenario = defineScenario({
      name: "skewed",
      thinkTime: { distribution: "none" },
      steps: [
        {
          name: "click",
          run: async ({ page, baseUrl }) => {
            if (page.url() === "about:blank") await page.goto(`${baseUrl}/`, { waitUntil: "load" });
            await page.click("#busy");
          },
        },
      ],
    });
    const { report } = await scenarioLoad({
      baseUrl,
      scenarios: [{ scenario, workers: 1 }],
      duration: "2s",
      perf: true,
      runtimeFaults: [faults.clockSkew(60_000, { name: "skew" })],
    });
    // Had the fault patched `performance.now` before the collector captured
    // it, the long tasks would sit a minute away from the span windows and
    // every span would report 0 ms blocking.
    const click = report.scenarios[0]!.steps[0]!;
    expect(click.perf).toBeDefined();
    expect(click.perf!.blockingMs.p50).toBeGreaterThanOrEqual(100);
  }, 60_000);

  it("measures the sampled worker's steps and reports blocking per step and per bucket", async () => {
    const scenario = defineScenario({
      name: "busy",
      thinkTime: { distribution: "none" },
      steps: [
        {
          name: "open",
          run: async ({ page, baseUrl }) => {
            await page.goto(`${baseUrl}/`, { waitUntil: "load" });
          },
        },
        {
          name: "click",
          run: async ({ page }) => {
            await page.click("#busy");
          },
        },
      ],
    });

    const { report } = await scenarioLoad({
      baseUrl,
      scenarios: [{ scenario, workers: 2 }],
      duration: "3s",
      timelineBucketMs: 1000,
      perf: true,
    });

    expect(report.config.perf).toEqual({ level: "light", sampledWorkers: 1 });
    const steps = report.scenarios[0]!.steps;
    const open = steps.find((s) => s.name === "open")!;
    const click = steps.find((s) => s.name === "click")!;
    expect(click.perf).toBeDefined();
    expect(open.perf).toBeDefined();
    const sampledIterations = report.workers[0]!.iterations;
    // Only worker 0 measures: its spans are a subset of the step's executions.
    expect(click.perf!.n).toBeGreaterThanOrEqual(1);
    expect(click.perf!.n).toBeLessThanOrEqual(sampledIterations + 1);
    expect(click.perf!.n).toBeLessThan(click.invocations);
    // The handler blocks the main thread for at least 120 ms per click, and a
    // span is never shorter than what blocked inside it.
    expect(click.perf!.blockingMs.p50).toBeGreaterThanOrEqual(100);
    expect(click.perf!.durationMs.p50).toBeGreaterThanOrEqual(click.perf!.blockingMs.p50);
    // The click is an interaction whose handler ran for 120 ms; the final
    // drain in finish() picks its entry up even when its paint landed after
    // the span closed.
    expect(click.perf!.interactionMs).toBeDefined();
    expect(click.perf!.interactionMs!.p50).toBeGreaterThanOrEqual(100);

    // Every bucket carries the perf block; its spans are the measured steps
    // that ended inside the run window.
    expect(report.timeline.length).toBeGreaterThan(0);
    expect(report.timeline.every((b) => b.perf !== undefined)).toBe(true);
    const bucketed = report.timeline.reduce((a, b) => a + b.perf!.spans, 0);
    expect(bucketed).toBeGreaterThan(0);
    expect(bucketed).toBeLessThanOrEqual(click.perf!.n + open.perf!.n);
    expect(report.timeline.every((b) => b.perf!.startedWorkers === 2)).toBe(true);

    expect(() =>
      assertSlo(report, { steps: { "busy/click": { perf: { blockingMsP50: 10_000 } } } }),
    ).not.toThrow();
    expect(() =>
      assertSlo(report, { steps: { "busy/click": { perf: { blockingMsP50: 50 } } } }),
    ).toThrow(/perf\.blockingMsP50/);

    const text = formatLoadReport(report);
    expect(text).toContain("browser n=");
    expect(text).toContain("blocking p95");
  }, 60_000);
});
