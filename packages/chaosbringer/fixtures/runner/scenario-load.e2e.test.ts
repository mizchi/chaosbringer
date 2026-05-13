/**
 * End-to-end smoke for `scenarioLoad`: spin up the fixture HTTP server,
 * run 2 workers × ~3s against a 2-step scenario, and assert the
 * collected LoadReport actually reflects the real run (iterations
 * happened, endpoints were sampled, timeline is populated).
 *
 * Slow (boots Chromium). Kept in `fixtures/runner/` next to the
 * existing crawler smoke test so both share the browser install gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faults } from "../../src/faults.js";
import {
  defineScenario,
  formatLoadReport,
  scenarioLoad,
} from "../../src/load/index.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer(0);
}, 30000);

afterAll(async () => {
  await server.close();
});

describe("scenarioLoad against fixture site", () => {
  it("runs workers, samples endpoints, and produces a populated timeline", async () => {
    const scenario = defineScenario({
      name: "browse",
      thinkTime: { distribution: "none" },
      steps: [
        {
          name: "home",
          run: async ({ page, baseUrl }) => {
            await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
          },
        },
        {
          name: "about",
          run: async ({ page, baseUrl }) => {
            await page.goto(`${baseUrl}/about`, { waitUntil: "domcontentloaded" });
          },
        },
      ],
    });

    const { report } = await scenarioLoad({
      baseUrl: server.url,
      scenarios: [{ scenario, workers: 2 }],
      duration: "3s",
      timelineBucketMs: 500,
    });

    expect(report.config.workers).toBe(2);
    expect(report.scenarios.length).toBe(1);

    const browse = report.scenarios[0]!;
    expect(browse.name).toBe("browse");
    expect(browse.iterations).toBeGreaterThan(0);
    // Both step names should appear in the rollup.
    expect(browse.steps.map((s) => s.name).sort()).toEqual(["about", "home"]);
    // At least one endpoint sample with a 2xx — the fixture home page is HTML.
    expect(report.endpoints.length).toBeGreaterThan(0);
    const homeEndpoint = report.endpoints.find((e) => e.key === "/");
    expect(homeEndpoint).toBeDefined();
    expect(homeEndpoint!.count).toBeGreaterThan(0);

    // Timeline buckets cover the run window (3s @ 500ms = 6 buckets).
    expect(report.timeline.length).toBeGreaterThanOrEqual(5);
    expect(report.timeline.length).toBeLessThanOrEqual(7);
    const totalTimelineIters = report.timeline.reduce(
      (a, b) => a + b.iterations,
      0,
    );
    expect(totalTimelineIters).toBe(browse.iterations);

    // Sanity: ASCII formatter doesn't throw on a real report.
    const text = formatLoadReport(report);
    expect(text).toContain("Scenario: browse");
    expect(text).toContain("Timeline (bucket=500ms)");
  }, 60000);

  it("co-exists with chaos: 100% network 500 still completes (errors recorded)", async () => {
    const scenario = defineScenario({
      name: "consume-api",
      thinkTime: { distribution: "none" },
      steps: [
        {
          name: "open",
          run: async ({ page, baseUrl }) => {
            await page.goto(`${baseUrl}/api-consumer`, {
              waitUntil: "domcontentloaded",
            });
          },
        },
      ],
    });

    const { report, faultStats } = await scenarioLoad({
      baseUrl: server.url,
      scenarios: [{ scenario, workers: 1 }],
      duration: "2s",
      faultInjection: [
        faults.status(500, { urlPattern: "/api/", probability: 1 }),
      ],
      timelineBucketMs: 1000,
    });

    // Workers completed iterations even with 100% API failures
    // (`/api/data` is fetched by the page; the navigation still resolves).
    expect(report.scenarios[0]!.iterations).toBeGreaterThan(0);
    // Fault rule matched + injected at least once.
    expect(faultStats.length).toBe(1);
    expect(faultStats[0]!.injected).toBeGreaterThan(0);
    // Network errors registered on the API endpoint.
    const api = report.endpoints.find((e) => e.key.startsWith("/api"));
    expect(api).toBeDefined();
    expect(api!.errorCount).toBeGreaterThan(0);
  }, 60000);
});
