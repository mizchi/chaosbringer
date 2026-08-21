/**
 * End-to-end regression for the whole model-driven pipeline.
 *
 * The plans are committed artifacts compiled from Apalache witnesses, so this
 * test needs no Quint and no JVM. It asserts the two directions that matter:
 *
 *   buggy app  → the enumerated states catch both seeded bugs, by name
 *   fixed app  → all 16 plans pass, so the plans are not just noise
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateCoverage,
  formatModelCoverage,
  modelRunPassed,
  resolvePlanTiming,
  runPlans,
  validatePlan,
  type FaultPlan,
  type PlanRunResult,
} from "chaosbringer";
import { afterAll, describe, expect, it } from "vitest";
import bridge from "./model/bridge.mjs";
import { startServer, type StartedServer } from "./server.js";
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

const servers: StartedServer[] = [];
async function boot(fixed: boolean): Promise<StartedServer> {
  const server = await startServer(0, fixed);
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

function mismatchKeys(results: PlanRunResult[]): string[] {
  return results
    .flatMap((r) => r.mismatches.map((m) => `${m.plan}/${m.field}`))
    .sort();
}

describe("model-driven fault coverage", () => {
  const plans = loadPlans();

  it("keeps the bridge's appDeadlineMs in step with the app's own deadline", () => {
    // Every timing value is derived from this number, so drift between the
    // app and the bridge would silently invalidate the whole suite.
    const appSource = readFileSync(join(here, "public", "app.js"), "utf8");
    const match = appSource.match(/const DEADLINE_MS = (\d+)/);
    expect(match, "public/app.js must declare DEADLINE_MS").not.toBeNull();
    expect(bridge.appDeadlineMs).toBe(Number(match![1]));
  });

  it("solves the settle window instead of hand-picking it", () => {
    const profile = bridge.timingProfile;
    const timing = resolvePlanTiming({
      appDeadlineMs: bridge.appDeadlineMs,
      timingProfile: profile,
    });
    // Must outlast the app's own deadline, or a bounded request reads as stuck.
    expect(timing.settleMs).toBeGreaterThan(bridge.appDeadlineMs!);
    // …and it must be the app's deadline plus this machine's own jitter and
    // nothing else. The assertion used to be `< 1600` — "beats the old
    // hand-picked guess" — which is a fact about a deleted constant and a
    // tripwire against any honest increase in the profile's tails: raising
    // `tightTailMs` from a warm 3ms to a measured 52ms is the fix for a real
    // flake, and it moves this number. What is worth enforcing forever is that
    // the window is *derived*, so the bound is derived too (safety 2, the
    // solver's default margin 25).
    const budgetMs = bridge.appDeadlineMs! + profile!.tightTailMs * 2 + 25;
    expect(timing.settleMs).toBeLessThanOrEqual(budgetMs);
    // Nothing was hand-picked: the same closed form, spelled out.
    expect(timing.settleMs).toBe(budgetMs);
    // And the observation window is one more round of the same size.
    expect(timing.quiescenceMs).toBe(budgetMs);
  });

  it("reports the two states the enumeration proved unreachable, as unreachable", () => {
    // The claim a probability sweep cannot make, and the one nothing used to
    // assert: `modelRunPassed` never looks at `statesUnreachableInBound`, so
    // when `enumerate.sh` started writing `unreachable-live` /
    // `unreachable-by-construction` the runner's `status === "unreachable"`
    // parse silently reported both contract-forbidden states as REACHED —
    // "the model reached a state its own contract forbids" — and every test
    // stayed green. This pins the count and the direction.
    const targets = loadTargets(modelDir);
    expect(targets).toHaveLength(18);

    const unreachable = targets.filter((t) => t.status === "unreachable");
    expect(unreachable.map((t) => t.target)).toEqual([
      "contract-forbids-stuck",
      "contract-forbids-unhandled",
    ]);
    // Every contract-forbids row is classified (F6): an unreachable row with
    // no verdict is a query nobody knows could have failed.
    for (const row of unreachable) {
      expect(row.verdict, `${row.target} is unclassified in targets.txt`).toBeDefined();
    }
    expect(targets.filter((t) => t.status === "reachable")).toHaveLength(16);

    // …and the report says so, at the depth the enumeration actually ran at.
    const coverage = aggregateCoverage([], {
      depthBound: depthBoundOf(modelDir),
      targets,
    });
    expect(coverage.statesTargeted).toBe(18);
    expect(coverage.statesReachable).toBe(16);
    expect(coverage.statesUnreachableInBound).toBe(2);
    expect(formatModelCoverage(coverage)).toContain(
      "States: 16/18 reachable (depth <= 4), 2 unreachable",
    );
  });

  it("compiled one plan per reachable model state", () => {
    // 4 outcomes x 2 operations = 16 reachable combinations.
    expect(plans).toHaveLength(16);
    // Every plan pins both operations, and none needs cross-operation
    // ordering (which a browser cannot enforce).
    for (const plan of plans) {
      expect(plan.schedule).toHaveLength(2);
      expect(plan.orderSensitive).toBeUndefined();
      expect(plan.expect.unhandledRejection).toBe(false);
    }
  });

  it("catches both seeded bugs in the buggy variant", async () => {
    const server = await boot(false);
    const results = await runPlans(plans, { ...bridge, baseUrl: server.url });
    const keys = mismatchKeys(results);

    // BUG-1 (nothing bounds the load): every state where a request never
    // settles leaves the spinner up, where the contract says "error".
    expect(keys).toContain("cart-hung__shipping-fulfilled/ui");
    expect(keys).toContain("cart-fulfilled__shipping-hung/ui");
    for (const r of results) {
      if (r.plan.name === "cart-hung__shipping-fulfilled") {
        expect(r.observed.ui).toBe("stuck");
      }
    }

    // BUG-2 (eager start, sequential await): the second promise has no
    // handler attached at the moment it rejects, so the rejection escapes.
    expect(keys).toContain("cart-fulfilled__shipping-rejected/unhandledRejection");
    expect(keys).toContain("cart-rejected__shipping-rejected/unhandledRejection");

    // The happy path must still be clean, or the harness is just noisy.
    const happy = results.find((r) => r.plan.name === "cart-fulfilled__shipping-fulfilled")!;
    expect(happy.mismatches).toEqual([]);
    expect(happy.observed.ui).toBe("ready");

    // Every plan actually exercised its faults — no silent "state not reached".
    const coverage = aggregateCoverage(results);
    expect(coverage.plansNotExercised).toEqual([]);
    expect(coverage.plansSkipped).toBe(0);
    expect(coverage.mismatches.length).toBeGreaterThanOrEqual(10);
  }, 300000);

  it("passes every plan once both bugs are fixed", async () => {
    const server = await boot(true);
    const results = await runPlans(plans, { ...bridge, baseUrl: server.url });
    // Aggregated exactly the way `run.ts` does it, targets included: the
    // coverage claim the example prints is part of what passes here.
    const coverage = aggregateCoverage(results, {
      depthBound: depthBoundOf(modelDir),
      targets: loadTargets(modelDir),
    });
    expect(mismatchKeys(results)).toEqual([]);
    expect(modelRunPassed(coverage)).toBe(true);
    expect(coverage.plansRun).toBe(16);
    expect(coverage.statesUnreachableInBound).toBe(2);
    expect(coverage.statesReachable).toBe(16);
  }, 300000);
});
