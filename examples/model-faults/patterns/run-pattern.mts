/**
 * Replay one pattern's plans against the checkout app.
 *
 *   npx tsx patterns/run-pattern.mts retry-idempotency        # buggy variant
 *   FIXED=1 npx tsx patterns/run-pattern.mts retry-idempotency  # corrected app
 *
 * `FIXED` is the switch (line ~33), the same convention as `pnpm start` /
 * `pnpm start:fixed`; there is no `--fixed` flag.
 *
 * Every pattern is the same shape — a model, its committed plans, a bridge and
 * a page — so adding one needs no new runner.
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
import { startServer } from "../server.js";
import { depthBoundOf, loadTargets } from "../targets.js";
import { PATTERNS } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [name] = process.argv.slice(2);
const pattern = PATTERNS.find((p) => p.name === name);
if (!pattern) {
  console.error(`unknown pattern "${name}". Known: ${PATTERNS.map((p) => p.name).join(", ")}`);
  process.exit(2);
}

const fixed = process.env.FIXED === "1";
const plans: FaultPlan[] = readdirSync(join(here, pattern.name, "plans"))
  .filter((f) => f.endsWith(".plan.json"))
  .sort()
  .map((f) => {
    const plan = JSON.parse(readFileSync(join(here, pattern.name, "plans", f), "utf8")) as FaultPlan;
    validatePlan(plan);
    return plan;
  });

const server = await startServer(0, fixed);
console.log(`${pattern.name} (${fixed ? "fixed" : "buggy"}) on ${server.url}${pattern.path}\n`);
try {
  const bridge = (await import(`./${pattern.name}/bridge.mjs`)).default;
  const results = await runPlans(plans, { ...bridge, baseUrl: `${server.url}${pattern.path}` });
  // Fingerprints are empty unless the bridge asked for them, so this costs
  // nothing for the patterns that do not — and without it a bridge that sets
  // `coverageFingerprints` would collect the digests and report nothing, which
  // is the shape of bug this whole example exists to catch.
  // `targets` and `depthBound` come from the unit's own enumeration
  // bookkeeping. Without them the report says `N/N reachable` with no bound —
  // structurally unable to mention the `unreachable-*` rows that are the whole
  // point of enumerating instead of sampling.
  const unitDir = join(here, pattern.name);
  const coverage = aggregateCoverage(results, {
    spec: pattern.spec,
    depthBound: depthBoundOf(unitDir),
    targets: loadTargets(unitDir),
    fingerprints: fingerprintsOf(results),
  });
  console.log(formatModelCoverage(coverage));
  process.exitCode = modelRunPassed(coverage) ? 0 : 1;
} finally {
  await server.close();
}
