/**
 * Compare committed plans against a fresh enumeration, semantically.
 *
 *   node model/check-plans.mjs <committed-dir> <regenerated-dir>
 *
 * A plain `git diff` cannot do this job, for two reasons observed in CI:
 *
 *   1. ITF traces carry a "Created by Apalache on <timestamp>" line, so a
 *      regeneration always looks dirty.
 *   2. The solver may return a different-but-equivalent witness for the same
 *      target — e.g. reject(cart) then reject(shipping) instead of the
 *      reverse. Both reach the same state and replay identically, because
 *      cross-operation settlement order is not enforceable anyway.
 *
 * So this compares what actually matters: per state, the *set* of
 * (operation, occurrence, outcome) injections and the oracle. Provenance
 * fields (`spec`, `modelSteps`) are ignored.
 *
 * Exit 0 = plans agree. Exit 1 = the model or the witnesses changed, and the
 * committed plans need regenerating (or the change needs review).
 *
 * Shared by every example that carries a `model/` directory (the workflow
 * calls it with that example's plan directory), which is why it takes both
 * paths as arguments instead of hardcoding this example's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function load(dir) {
  const out = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort()) {
    const plan = JSON.parse(readFileSync(join(dir, file), "utf8"));
    out.set(plan.name, {
      // Sorted so a witness that reaches the same state by settling the same
      // operations in the other order compares equal — cross-operation order
      // is not enforceable at replay time anyway.
      schedule: [...plan.schedule]
        .map((s) => `${s.rule}@${s.occurrence}=${s.outcome}`)
        .sort(),
      expect: plan.expect ?? {},
      orderSensitive: plan.orderSensitive === true,
    });
  }
  return out;
}

const [committedDir, freshDir] = process.argv.slice(2);
if (!committedDir || !freshDir) {
  console.error("usage: node check-plans.mjs <committed-dir> <regenerated-dir>");
  process.exit(2);
}

const committed = load(committedDir);
const fresh = load(freshDir);
const problems = [];

for (const [name, plan] of fresh) {
  const was = committed.get(name);
  if (!was) {
    problems.push(`new state reachable, no committed plan: ${name}`);
    continue;
  }
  const a = JSON.stringify(was);
  const b = JSON.stringify(plan);
  if (a !== b) problems.push(`plan changed: ${name}\n    committed: ${a}\n    fresh:     ${b}`);
}
for (const name of committed.keys()) {
  if (!fresh.has(name)) problems.push(`committed plan no longer reachable: ${name}`);
}

if (problems.length > 0) {
  console.error(`${problems.length} plan difference(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  // The remediation has to name the unit that drifted, not this example's
  // scripts: `pnpm compile` is hardcoded to `model/traces` -> `model/plans`, so
  // it is the wrong command for the eight other units this same file checks.
  // The committed directory is `<unit>/plans`, which is where the unit is.
  const unit = committedDir.replace(/[/\\]plans[/\\]?$/, "");
  console.error(
    `\nRegenerate with \`${unit}/enumerate.sh && ${unit}/compile.sh\` ` +
      `(needs Quint + a JVM, and \`pnpm -F chaosbringer build\` for the compile step), ` +
      `review, and commit.`,
  );
  process.exit(1);
}
console.log(`plans are up to date (${fresh.size} states)`);
