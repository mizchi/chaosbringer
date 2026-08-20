/**
 * Every pattern, both variants.
 *
 * The shape is the same for each: the buggy variant must produce the specific
 * mismatch the pattern exists to catch, and the fixed variant must produce
 * none. A pattern that only ever passes proves nothing, and one that always
 * fails is noise — so both directions are asserted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateCoverage,
  modelRunPassed,
  runPlans,
  validatePlan,
  type FaultPlan,
  type PlanRunResult,
} from "chaosbringer";
import { afterAll, describe, expect, it } from "vitest";
import { startServer, type StartedServer } from "../server.js";
import { PATTERNS } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const servers: StartedServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function loadPlans(pattern: string): FaultPlan[] {
  const dir = join(here, pattern, "plans");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".plan.json"))
    .sort()
    .map((f) => {
      const plan = JSON.parse(readFileSync(join(dir, f), "utf8")) as FaultPlan;
      validatePlan(plan);
      return plan;
    });
}

async function run(pattern: (typeof PATTERNS)[number], fixed: boolean): Promise<PlanRunResult[]> {
  const server = await startServer(0, fixed);
  servers.push(server);
  const bridge = (await import(`./${pattern.name}/bridge.mjs`)).default;
  return runPlans(loadPlans(pattern.name), {
    ...bridge,
    baseUrl: `${server.url}${pattern.path}`,
  });
}

function keys(results: PlanRunResult[]): string[] {
  return results.flatMap((r) => r.mismatches.map((m) => `${m.plan}/${m.field}`)).sort();
}

describe("pattern: retry-idempotency", () => {
  const pattern = PATTERNS.find((p) => p.name === "retry-idempotency")!;

  it("enumerated the per-attempt grid, not just the terminal states", () => {
    const plans = loadPlans(pattern.name);
    // 1 (first attempt succeeds) + 2 x 3 (first fails, retry has 3 outcomes).
    expect(plans).toHaveLength(7);
    // Every plan asserts the contract: one intent, at most one order.
    for (const plan of plans) {
      expect(Number(plan.expect.state!.orders)).toBeLessThanOrEqual(1);
    }
  });

  it("catches the double-write, and only where the server had already committed", async () => {
    const results = await run(pattern, false);
    const mismatches = keys(results);

    // reject-body = the server committed but the client could not read the
    // reply. Retrying that without one key per intent writes twice.
    expect(mismatches).toContain("first-rejectAfter__then-fulfil/state");
    expect(mismatches).toContain("first-rejectAfter__then-rejectAfter/state");
    const doubled = results.find((r) => r.plan.name === "first-rejectAfter__then-fulfil")!;
    expect(doubled.observed.state).toEqual({ orders: 2 });
    // …and the UI said everything was fine, which is why this needs a state probe.
    expect(doubled.observed.ui).toBe("placed");

    // A failure BEFORE the server committed is safe to retry: nothing was
    // written, so those plans must pass. If they did not, the pattern would be
    // flagging retries in general rather than unsafe ones.
    for (const name of [
      "first-rejectBefore__then-fulfil",
      "first-rejectBefore__then-rejectBefore",
      "first-fulfil",
    ]) {
      expect(results.find((r) => r.plan.name === name)!.mismatches).toEqual([]);
    }
  }, 300000);

  it("passes every plan once one idempotency key covers the whole intent", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});
