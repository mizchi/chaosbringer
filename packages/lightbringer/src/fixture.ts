// The @playwright/test fixture. Kept separate from collector.ts so the core (and
// the CLI that reuses it) doesn't import the @playwright/test runtime — this file
// is the only place that does. Derives session options from PERF_* env vars and
// writes/attaches the artifacts the test runner expects.
import fs from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import {
  startSession,
  logSummary,
  checkBudgets,
  PerfController,
  PERF_OUT_DIR,
  CPU_RATE,
  NET_PROFILE,
  CSS_STATS,
  TRACE_ENABLED,
  COV_ENABLED,
  MEM_GC,
} from "./collector";

export const test = base.extend<{ perf: PerfController }>({
  perf: async ({ page }, use, testInfo) => {
    // Full title path avoids file collisions across describe blocks / looped tests.
    const slug = testInfo.titlePath
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}_]+/gu, "_");
    const runTag = `run${testInfo.repeatEachIndex}`;
    const tracePath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.trace.json`);
    if (TRACE_ENABLED) fs.mkdirSync(PERF_OUT_DIR, { recursive: true });

    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client, {
      cpuRate: CPU_RATE,
      netProfile: NET_PROFILE,
      cssStats: CSS_STATS,
      trace: TRACE_ENABLED,
      tracePath,
      coverage: COV_ENABLED,
      memGc: MEM_GC,
    });
    // Scale the test timeout under CPU throttling so fixed waitFor/navigation
    // timeouts don't trip (the expect() timeout is global; raise it in config).
    if (CPU_RATE > 1 && testInfo.timeout > 0) {
      testInfo.setTimeout(testInfo.timeout * CPU_RATE);
    }

    await use(session.controller);

    const { report, covArtifact } = await session.finish(testInfo.title);

    fs.mkdirSync(PERF_OUT_DIR, { recursive: true });
    const jsonPath = path.join(PERF_OUT_DIR, `${slug}.${runTag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    // Range artifact for cross-scenario union (scripts/coverage.mjs).
    if (covArtifact) {
      fs.writeFileSync(
        path.join(PERF_OUT_DIR, `${slug}.${runTag}.coverage.json`),
        JSON.stringify(covArtifact),
      );
    }
    await testInfo.attach("perf-report", {
      path: jsonPath,
      contentType: "application/json",
    });

    logSummary(report, MEM_GC);

    // Inline budget assertion (opt-in). Off by default — a single run is noisy;
    // the statistically sound gate is the median script. PERF_ASSERT=1 fails fast.
    if (process.env.PERF_ASSERT === "1") {
      const violations = checkBudgets(report);
      if (violations.length > 0) {
        throw new Error(`perf budget exceeded:\n  ${violations.join("\n  ")}`);
      }
    }
  },
});

export { expect } from "@playwright/test";
