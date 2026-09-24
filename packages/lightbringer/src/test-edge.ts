// Shared body of the @playwright/test edges (the `perf` fixture in fixture.ts and
// the auto-span page fixture in autowrap.ts). Imports @playwright/test as TYPES
// ONLY — autowrap.ts must stay free of a value import (see its header). This is
// where PERF_* env vars become session options (sessionOptionsFromEnv) and where
// the report / coverage artifacts are written and attached.
import fs from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { runArtifactPath, slugify } from "./artifacts";
import { sessionOptionsFromEnv, toSessionOptions } from "./config";
import { startSession, type PerfSession } from "./session";
import { logSummary } from "./report";
import { checkBudgets } from "./report-types";

export async function runTestSession(
  page: Page,
  testInfo: TestInfo,
  body: (session: PerfSession) => Promise<void>,
): Promise<void> {
  const env = sessionOptionsFromEnv();
  // Full title path avoids file collisions across describe blocks / looped tests.
  const slug = slugify(testInfo.titlePath.filter(Boolean).join("_"));
  const runTag = `run${testInfo.repeatEachIndex}`;
  const tracePath = runArtifactPath(env.outDir, slug, runTag, "trace");
  if (env.trace) fs.mkdirSync(env.outDir, { recursive: true });

  const client = await page.context().newCDPSession(page);
  const session = await startSession(page, client, toSessionOptions(env, tracePath));
  // Scale the test timeout under CPU throttling so fixed waitFor/navigation
  // timeouts don't trip (the expect() timeout is global; raise it in config).
  if (env.cpuRate > 1 && testInfo.timeout > 0) {
    testInfo.setTimeout(testInfo.timeout * env.cpuRate);
  }

  await body(session);

  const { report, covArtifact } = await session.finish(testInfo.title);

  fs.mkdirSync(env.outDir, { recursive: true });
  const jsonPath = runArtifactPath(env.outDir, slug, runTag, "report");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  // Range artifact for cross-scenario union (scripts/coverage.mjs).
  if (covArtifact) {
    fs.writeFileSync(runArtifactPath(env.outDir, slug, runTag, "coverage"), JSON.stringify(covArtifact));
  }
  await testInfo.attach("perf-report", {
    path: jsonPath,
    contentType: "application/json",
  });

  logSummary(report, env.memGc);

  // Inline budget assertion (opt-in). Off by default — a single run is noisy;
  // the statistically sound gate is the median script. PERF_ASSERT=1 fails fast.
  if (env.assert) {
    const violations = checkBudgets(report);
    if (violations.length > 0) {
      throw new Error(`perf budget exceeded:\n  ${violations.join("\n  ")}`);
    }
  }
}
