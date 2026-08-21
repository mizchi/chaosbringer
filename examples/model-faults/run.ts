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
import { depthBoundOf, loadTargets } from "./targets.js";

const here = dirname(fileURLToPath(import.meta.url));
const modelDir = join(here, "model");
const plansDir = join(modelDir, "plans");

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
  // Enumeration bookkeeping, so unreachable states are reported rather than
  // dropped — and the depth bound comes from the enumeration itself, not from
  // a number retyped here.
  const coverage = aggregateCoverage(results, {
    spec: "model/checkout.qnt",
    depthBound: depthBoundOf(modelDir),
    targets: loadTargets(modelDir),
    fingerprints: fingerprintsOf(results),
  });
  console.log(formatModelCoverage(coverage));
  process.exitCode = modelRunPassed(coverage) ? 0 : 1;
} finally {
  await server.close();
}
