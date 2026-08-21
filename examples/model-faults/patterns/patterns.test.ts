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
import { resolvePlanTiming } from "chaosbringer";
import { startServer, type StartedServer } from "../server.js";
import { PATTERNS } from "./index.mjs";
import timeoutLadderBridge from "./timeout-ladder/bridge.mjs";

/** Bridges are plain JS modules; this keeps the import list honest. */
function bridgeOf(name: string) {
  if (name === "timeout-ladder") return timeoutLadderBridge;
  throw new Error(`no bridge wired for ${name}`);
}

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

describe("pattern: token-refresh", () => {
  const pattern = PATTERNS.find((p) => p.name === "token-refresh")!;

  it("asserts one refresh per expiry, whatever the 401 fan-out", () => {
    const plans = loadPlans(pattern.name);
    expect(plans).toHaveLength(4); // {me fresh|expired} x {prefs fresh|expired}
    for (const plan of plans) {
      expect(Number(plan.expect.state!.refreshes)).toBeLessThanOrEqual(1);
      // Every enumerated state ends ready: an expiry the app handles must
      // never reach the user as an error.
      expect(plan.expect.ui).toBe("ready");
    }
  });

  it("catches the stampede, and only when both requests hit 401 together", async () => {
    const results = await run(pattern, false);

    // Two concurrent 401s, one shared refresh required.
    const both = results.find((r) => r.plan.name === "me-replayed__prefs-replayed")!;
    expect(both.mismatches.map((m) => m.field)).toEqual(["state"]);
    expect(both.observed.state).toEqual({ refreshes: 2 });
    // The user saw nothing wrong — hence the state probe.
    expect(both.observed.ui).toBe("ready");

    // One 401 needs one refresh in either variant: these are the controls, and
    // if they failed the pattern would be flagging refreshes in general.
    for (const name of ["me-replayed__prefs-fresh", "me-fresh__prefs-replayed"]) {
      const control = results.find((r) => r.plan.name === name)!;
      expect(control.mismatches).toEqual([]);
      expect(control.observed.state).toEqual({ refreshes: 1 });
    }
    // No expiry, no refresh.
    expect(
      results.find((r) => r.plan.name === "me-fresh__prefs-fresh")!.observed.state,
    ).toEqual({ refreshes: 0 });
  }, 300000);

  it("passes every plan once the refresh is a single shared in-flight promise", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});

describe("pattern: optimistic-rollback", () => {
  const pattern = PATTERNS.find((p) => p.name === "optimistic-rollback")!;

  it("bounds the reconcile read, which no state probe could report", () => {
    const plans = loadPlans(pattern.name);
    expect(plans).toHaveLength(4); // fulfil | rejectBefore | serverError | rejectAfter

    // A success needs no reconcile; every failure does, because the app cannot
    // tell "never arrived" from "arrived, reply lost" without asking.
    const byName = new Map(plans.map((p) => [p.name, p]));
    expect(byName.get("write-fulfil")!.expect.calls).toEqual({ list: 1, note: 1 });
    for (const name of ["write-rejectBefore", "write-serverError", "write-rejectAfter"]) {
      expect(byName.get(name)!.expect.calls).toEqual({ list: 2, note: 1 });
    }
    // …and the schedule still names occurrence 0 only. The reconcile is app
    // behaviour, not an injection point, which is exactly why the occurrence
    // schedule cannot express this bound and expect.calls has to.
    for (const plan of plans) {
      expect(plan.schedule.filter((s) => s.rule === "list")).toHaveLength(1);
    }
  });

  it("catches the row the server never took, and the row it did", async () => {
    const results = await run(pattern, false);
    const byName = new Map(results.map((r) => [r.plan.name, r]));

    // Nothing committed, row still on screen: the user believes it saved.
    for (const name of ["write-rejectBefore", "write-serverError"]) {
      const r = byName.get(name)!;
      expect(r.mismatches.map((m) => m.field).sort()).toEqual(["amplification", "state"]);
      expect(r.observed.state).toEqual({ committed: 0, shown: 1 });
    }

    // The one that makes the pattern worth having. The server DID commit, so
    // the row on screen is correct and every state assertion passes — the app
    // is right by luck, having verified nothing. Only the missing reconcile
    // read separates it from an app that knows.
    const ambiguous = byName.get("write-rejectAfter")!;
    expect(ambiguous.mismatches.map((m) => m.field)).toEqual(["amplification"]);
    expect(ambiguous.observed.state).toEqual({ committed: 1, shown: 1 });
    expect(ambiguous.observed.matched.list).toBe(1);

    // The control: an optimistic update that succeeds must pass in both
    // variants, or the pattern would be flagging optimistic UI in general.
    expect(byName.get("write-fulfil")!.mismatches).toEqual([]);
  }, 300000);

  it("passes every outcome once the app asks the server instead of guessing", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});

describe("pattern: pagination-order", () => {
  const pattern = PATTERNS.find((p) => p.name === "pagination-order")!;

  it("enumerates a pair of states no per-plan expectation can tell apart", () => {
    const plans = loadPlans(pattern.name);
    expect(plans).toHaveLength(3); // page 1 fulfil | slow | rejected
    const byName = new Map(plans.map((p) => [p.name, p]));

    // The point of the pattern, visible in the plans themselves: prompt and
    // slow predict *identical* oracles. Everything the model can say about the
    // two states is the same, and only the injection differs.
    expect(byName.get("page1-fulfil")!.expect).toEqual(byName.get("page1-slow")!.expect);
    expect(byName.get("page1-fulfil")!.schedule[0]!.outcome).toBe("pass");
    expect(byName.get("page1-slow")!.schedule[0]!.outcome).toBe("slow-ok");

    // Portability: the plan says "slow", never a millisecond value.
    expect(JSON.stringify(plans)).not.toMatch(/\d{3,}/);
  });

  it("derives the losing delay from the app's own deadline", async () => {
    const appSource = readFileSync(join(here, "..", "public", "feed.js"), "utf8");
    const declared = Number(appSource.match(/const DEADLINE_MS = (\d+)/)![1]);
    const bridge = (await import("./pagination-order/bridge.mjs")).default;
    expect(bridge.appDeadlineMs).toBe(declared);

    // The delay has to be tolerable — a page 1 that misses the app's own bound
    // would be a *timeout* test, and the rows would legitimately be absent
    // rather than out of order. This pattern needs both pages to arrive.
    const timing = resolvePlanTiming({
      appDeadlineMs: declared,
      timingProfile: bridge.timingProfile,
    });
    expect(timing.delays!.fastMs).toBeLessThan(declared);
    expect(timing.delays!.fastMs).toBeGreaterThan(0);
  });

  it("catches the out-of-order render that every other signal calls healthy", async () => {
    const results = await run(pattern, false);
    const raced = results.find((r) => r.plan.name === "page1-slow")!;

    // One mismatch, and it is the invariant. Everything the model predicted
    // came true: the label, the row count, no escaped rejection.
    expect(raced.mismatches.map((m) => m.field)).toEqual(["uiInvariant"]);
    expect(raced.observed.ui).toBe("ready");
    expect(raced.observed.state).toEqual({ items: 4 });
    expect(raced.observed.unhandledRejection).toBe(false);
    // …and the invariant says which rows, in which order, because a report
    // that only said "invariant failed" would not be actionable.
    expect(raced.mismatches[0]!.detail).toMatch(/rendered 3,4,1,2/);

    // Controls. Prompt pages and a failed page must both pass in the buggy
    // variant: arrival order only reorders anything when a response is late,
    // and a pattern that failed here would be flagging pagination in general.
    for (const name of ["page1-fulfil", "page1-rejectBefore"]) {
      expect(results.find((r) => r.plan.name === name)!.mismatches).toEqual([]);
    }
  }, 300000);

  it("passes every plan once the list is rendered from page order, not arrival order", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});

describe("pattern: reconnect-budget", () => {
  const pattern = PATTERNS.find((p) => p.name === "reconnect-budget")!;

  it("puts the whole contract in a call count, because nothing on screen holds it", () => {
    const plans = loadPlans(pattern.name);
    expect(plans).toHaveLength(4); // connect on attempt 1 | 2 | 3 | budget spent
    const byName = new Map(plans.map((p) => [p.name, p]));

    // One rung per attempt that finally connects, and the rung where the
    // budget runs out. The count is the assertion.
    expect(byName.get("connect-on-1")!.expect.calls).toEqual({ stream: 1 });
    expect(byName.get("connect-on-2")!.expect.calls).toEqual({ stream: 2 });
    expect(byName.get("connect-on-3")!.expect.calls).toEqual({ stream: 3 });
    expect(byName.get("budget-exhausted")!.expect.calls).toEqual({ stream: 3 });

    // No plan asserts state, because there is none to read: a client with a
    // budget and one without render the same spinner and the same connection.
    for (const plan of plans) expect(plan.expect.state).toBeUndefined();
  });

  it("catches the runaway loop, and names it as a request count", async () => {
    const results = await run(pattern, false);
    const spent = results.find((r) => r.plan.name === "budget-exhausted")!;

    // Both signals fire, and the pair is the finding. `ui` alone reads as a
    // labelling quibble — "predicted offline, got live" — which is how an
    // unbounded retry gets waved through. The call count is what says the
    // client kept going.
    expect(spent.mismatches.map((m) => m.field).sort()).toEqual(["amplification", "ui"]);
    expect(spent.mismatches.find((m) => m.field === "amplification")!.detail).toMatch(
      /predicted 3 call\(s\) on "stream", the app made 4/,
    );
    expect(spent.observed.ui).toBe("live");
    expect(spent.observed.matched.stream).toBe(4);

    // Controls: a client that connects inside the budget is indistinguishable
    // from a correct one, and must pass. Without these the pattern would be
    // flagging reconnection itself.
    for (const name of ["connect-on-1", "connect-on-2", "connect-on-3"]) {
      expect(results.find((r) => r.plan.name === name)!.mismatches).toEqual([]);
    }
  }, 300000);

  it("passes every rung once the client gives up and says so", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});

describe("pattern: timeout-ladder", () => {
  const pattern = PATTERNS.find((p) => p.name === "timeout-ladder")!;

  it("keeps milliseconds out of the committed plans", async () => {
    const plans = loadPlans(pattern.name);
    expect(plans).toHaveLength(3); // quick | slow-but-tolerable | too-slow
    expect(plans.map((p) => p.schedule[0]!.outcome).sort()).toEqual([
      "pass",
      "slow-ok",
      "slow-trip",
    ]);
    // Portability: the plan says "slow", never "553ms". The milliseconds come
    // from the local profile, so the same plan works on a slower runner.
    expect(JSON.stringify(plans)).not.toMatch(/\d{3,}/);
  });

  it("derives the delays from the app's own deadline", async () => {
    const appSource = readFileSync(join(here, "..", "public", "slow.js"), "utf8");
    const declared = Number(appSource.match(/const DEADLINE_MS = (\d+)/)![1]);
    expect(bridgeOf("timeout-ladder").appDeadlineMs).toBe(declared);

    const timing = resolvePlanTiming({
      appDeadlineMs: declared,
      timingProfile: bridgeOf("timeout-ladder").timingProfile,
    });
    // "Slow but tolerable" must land inside the app's bound…
    expect(timing.delays!.fastMs).toBeLessThan(declared);
    // …and "too slow" must outlast the probe, not merely the deadline: an
    // unbounded app still answers, and one that answers mid-probe reads as
    // healthy. This exact off-by-a-margin produced a false pass before the
    // slow_outlasts_probe constraint existed.
    expect(timing.delays!.slowMs).toBeGreaterThan(timing.settleMs);
  });

  it("catches the missing bound, and tolerates merely-slow responses", async () => {
    const results = await run(pattern, false);
    const tooSlow = results.find((r) => r.plan.name === "report-tooSlow")!;
    expect(tooSlow.mismatches.map((m) => m.field)).toEqual(["ui"]);
    expect(tooSlow.observed.ui).toBe("stuck");

    // The control: slow-but-inside-the-bound must render fine even in the
    // buggy variant. An app that failed here would be broken in the other
    // direction, and only enumerating the extremes would miss it.
    expect(results.find((r) => r.plan.name === "report-slow")!.mismatches).toEqual([]);
    expect(results.find((r) => r.plan.name === "report-quick")!.mismatches).toEqual([]);
  }, 300000);

  it("passes every rung once the request is bounded", async () => {
    const results = await run(pattern, true);
    expect(keys(results)).toEqual([]);
    expect(modelRunPassed(aggregateCoverage(results))).toBe(true);
  }, 300000);
});


