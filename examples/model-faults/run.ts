/**
 * Replay every enumerated state against the checkout app and print the
 * coverage report.
 *
 *   pnpm start          # buggy variant   — mismatches expected
 *   pnpm start:fixed    # corrected app   — expect a clean sheet
 *
 * No Quint, no JVM: the plans in model/plans/ are committed artifacts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateCoverage,
  fingerprintsOf,
  formatModelCoverage,
  modelRunPassed,
  runPlans,
  validatePlan,
  type FaultPlan,
} from "chaosbringer";
import bridge from "./model/bridge.mjs";
import { startServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const plansDir = join(here, "model", "plans");
const targetsFile = join(here, "model", "targets.txt");

function loadPlans(): FaultPlan[] {
  return readdirSync(plansDir)
    .filter((f) => f.endsWith(".plan.json"))
    .sort()
    .map((f) => {
      const plan = JSON.parse(readFileSync(join(plansDir, f), "utf8")) as FaultPlan;
      validatePlan(plan);
      return plan;
    });
}

/** Enumeration bookkeeping, so unreachable states are reported, not dropped. */
function loadTargets() {
  return readFileSync(targetsFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status, name] = line.trim().split(/\s+/);
      return {
        target: name ?? "?",
        status: status === "unreachable" ? ("unreachable" as const) : ("reachable" as const),
      };
    });
}

const fixed = process.env.FIXED === "1";
const server = await startServer(0, fixed);
console.log(`checkout app (${fixed ? "fixed" : "buggy"}) on ${server.url}\n`);

try {
  const plans = loadPlans();
  // `coverageFingerprints` adds a V8 profiler session per plan: it is what
  // lets the report say whether two distinct model states actually exercised
  // distinct code.
  const results = await runPlans(plans, {
    ...bridge,
    baseUrl: server.url,
    coverageFingerprints: true,
  });
  const coverage = aggregateCoverage(results, {
    spec: "model/checkout.qnt",
    depthBound: 4,
    targets: loadTargets(),
    fingerprints: fingerprintsOf(results),
  });
  console.log(formatModelCoverage(coverage));
  process.exitCode = modelRunPassed(coverage) ? 0 : 1;
} finally {
  await server.close();
}
