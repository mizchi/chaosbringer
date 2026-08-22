/**
 * BLUE TEAM guard-walk: try to make each new check fire on a correct app.
 *
 *   npx tsx redteam/guardwalk.mts
 *
 * A check that turns a blind spot into a flaky failure has not helped, so
 * every one of them gets pushed at from the other side: an app that
 * legitimately makes more calls than the model described, an observable that
 * is legitimately still moving when the probe reads it, an operation issued by
 * page load rather than by the action, and a page that never goes quiet.
 *
 * Each case states what the oracle *should* say. `EXPECT FAILED` here means a
 * new check is producing false positives — which is worse than the hole it
 * closed.
 */

import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  aggregateCoverage,
  modelRunPassed,
  runPlans,
  type FaultPlan,
  type PlanRunResult,
} from "chaosbringer";
import { startServer, type StartedServer } from "./server.js";

const servers: StartedServer[] = [];
const failures: string[] = [];

/**
 * The windows these cases run in, named once so the wall-clock budget in case
 * 4 is derived from them. `DRAIN_CAP_MS` is the runner's own default
 * (`asyncDrainCapMs`), which is the number that makes "wait for the app's
 * pending work" terminate at all.
 */
const SETTLE_MS = 400;
const DRAIN_CAP_MS = 3000;
/** Browser launch + navigation + the probe round trips. Generous, and stated. */
const LAUNCH_SLACK_MS = 4000;

async function boot(fixed: boolean): Promise<StartedServer> {
  const s = await startServer(0, fixed);
  servers.push(s);
  return s;
}

function expectVerdict(label: string, results: PlanRunResult[], fields: string[]): void {
  const coverage = aggregateCoverage(results);
  const got = results.flatMap((r) => r.mismatches.map((m) => m.field)).sort();
  const ok = JSON.stringify(got) === JSON.stringify([...fields].sort());
  console.log(
    `  EXPECT  ${ok ? "ok" : "FAILED"}  ${label}: fields=${JSON.stringify(got)} ` +
      `(want ${JSON.stringify(fields)}), modelRunPassed=${modelRunPassed(coverage)}`,
  );
  for (const m of results.flatMap((r) => r.mismatches)) console.log(`          ! ${m.field}: ${m.detail}`);
  if (!ok) failures.push(label);
}

const uiProbe = async (page: Page) => {
  const state = await page.locator("#app").getAttribute("data-state");
  return state === "loading" ? "stuck" : (state ?? "unknown");
};

// =====================================================================
// 1. Amplification against a model that never mentioned the page load.
//    /quote fetches on mount AND on the button, so a model written for the
//    button alone sees twice the calls its schedule names. This is why the
//    span comparison is opt-in — and the run below is what it would cost.
// =====================================================================
async function amplificationOverreach(): Promise<void> {
  console.log("\n=== 1. checkAmplification against a model that ignores the page load ===");
  const server = await boot(true);
  const plan: FaultPlan = {
    name: "quote-click-only",
    schedule: [{ order: 0, rule: "quote", outcome: "pass", occurrence: 0 }],
    expect: { ui: "ready", unhandledRejection: false },
  };
  const bridge = {
    rules: { quote: /\/api\/quote$/ },
    action: async (page: Page) => page.getByRole("button", { name: "Refresh price" }).click(),
    uiProbe,
    settleMs: SETTLE_MS,
    baseUrl: `${server.url}/quote`,
  };

  // Default: silent. The extra call is not a finding, because this model never
  // claimed to account for it.
  expectVerdict("1a default (off)", await runPlans([plan], bridge), []);
  // Opted in: it fires, and it is a false positive — the app is correct. The
  // flag is a statement about the model, not about the app.
  expectVerdict(
    "1b opted in — expected to fire on a CORRECT app",
    await runPlans([plan], { ...bridge, checkAmplification: true }),
    ["amplification"],
  );
}

// =====================================================================
// 2. A page-load operation, with no action at all. The counting rule has to
//    see it, or every all-`pass` plan for a page-load fetch becomes a false
//    "the app never issued that request".
// =====================================================================
async function pageLoadObservation(): Promise<void> {
  console.log("\n=== 2. an all-`pass` plan for an operation issued by page load ===");
  const server = await boot(true);
  const plan: FaultPlan = {
    name: "quote-on-mount",
    schedule: [{ order: 0, rule: "quote", outcome: "pass", occurrence: 0 }],
    expect: { ui: "ready", unhandledRejection: false },
  };
  const results = await runPlans([plan], {
    rules: { quote: /\/api\/quote$/ },
    uiProbe,
    settleMs: SETTLE_MS,
    baseUrl: `${server.url}/quote`,
  });
  console.log(`  observed.matched=${JSON.stringify(results[0]!.observed.matched)}`);
  expectVerdict("2 page-load fetch, no action", results, []);
}

// =====================================================================
// 3. An observable that is legitimately still moving when the probe reads it:
//    the FIXED order app against a backend that commits 450ms after it
//    answers, probed at 200ms. Probe reads 0, settled read reads 1, the model
//    said 1. Reporting the drift here would make every 202-Accepted API flake.
// =====================================================================
async function slowButCorrectCommit(): Promise<void> {
  console.log("\n=== 3. a write that commits after the probe but is still correct ===");
  const server = await boot(true);
  const plan: FaultPlan = {
    name: "order-once",
    schedule: [{ order: 0, rule: "order", outcome: "pass", occurrence: 0 }],
    expect: { ui: "placed", unhandledRejection: false, state: { orders: 1 } },
  };
  const results = await runPlans([plan], {
    rules: { order: { urlPattern: /\/api\/rt\/order$/, methods: ["POST"] } },
    action: async (page: Page) => page.getByRole("button", { name: "Place order" }).click(),
    uiProbe,
    stateProbe: async (page: Page) =>
      page.evaluate(async () => {
        const session = (window as unknown as { __SESSION__: string }).__SESSION__;
        const res = await fetch(`/api/rt/orders/count?session=${encodeURIComponent(session)}`);
        return (await res.json()) as { orders: number };
      }),
    settleMs: 200,
    quiescenceMs: 800,
    baseUrl: `${server.url}/order`,
  });
  const o = results[0]!.observed;
  const probed = Number(o.state?.orders);
  const settled = Number(o.stateSettled?.orders);
  console.log(
    `  probe=${JSON.stringify(o.state?.orders)} settled=${JSON.stringify(o.stateSettled?.orders)}` +
      ` — ${probed === settled ? "did NOT drift" : "drifted"}, and converged on the predicted value`,
  );
  expectVerdict("3 slow commit, correct result", results, []);
  // The guard being walked is "a drift that converges is not a failure", so the
  // drift has to have happened: with `settleMs: 200` against a backend that
  // commits 450ms after it answers, the probe must read the pre-commit value.
  // Printing "drifted" while asserting only the empty verdict is how this case
  // passes on a machine where the probe landed after the commit and therefore
  // demonstrated nothing.
  if (!(probed !== settled && settled === 1)) {
    failures.push(
      `3 no drift to tolerate: probe read ${probed} and the settled read ${settled} — the probe ` +
        `landed after the backend's commit, so this case did not exercise the guard ` +
        `(lower settleMs, or raise the server's COMMIT_LATENCY_MS)`,
    );
    console.log(`  EXPECT  FAILED  3 the probe read a value that later moved`);
  } else {
    console.log(
      `  EXPECT  ok  3 the probe read ${probed} where the model said ${settled}, and the ` +
        `settled read agreed — a drift the runner must not report`,
    );
  }
}

// =====================================================================
// 4. A page that never goes quiet. /poll leaves an uncleared setInterval, so
//    "wait for the app's pending work" must not mean "wait forever": intervals
//    are reported, never waited on.
// =====================================================================
async function neverQuiet(): Promise<void> {
  console.log("\n=== 4. an uncleared setInterval must be reported, not waited on ===");
  const server = await boot(false); // 60ms heartbeat, never cleared
  const plan: FaultPlan = {
    name: "feed-ok",
    schedule: [{ order: 0, rule: "feed", outcome: "pass", occurrence: 0 }],
    expect: { ui: "ready", unhandledRejection: false },
  };
  const startedAt = Date.now();
  const results = await runPlans([plan], {
    rules: { feed: /\/api\/feed$/ },
    action: async (page: Page) => page.getByRole("button", { name: "Start" }).click(),
    uiProbe,
    settleMs: SETTLE_MS,
    baseUrl: `${server.url}/poll`,
  });
  const elapsed = Date.now() - startedAt;
  const pending = results[0]!.observed.pendingAsync;
  console.log(
    `  pendingAsync=${JSON.stringify(pending)} wallClock=${elapsed}ms`,
  );
  expectVerdict("4 uncleared interval", results, []);
  // The phenomenon: the page really did leave a recurring timer behind. If it
  // did not, the guard below is being walked against a page that goes quiet on
  // its own and proves nothing.
  if (!((pending?.intervals ?? 0) > 0)) {
    failures.push(
      `4 no uncleared interval was observed (pendingAsync=${JSON.stringify(pending)}) — the ` +
        `page under this guard is supposed to leave a heartbeat running`,
    );
  }
  // …and the guard itself: intervals are *reported*, never waited on. The
  // budget is the run's own numbers — settle + drain cap + quiescence, plus
  // browser launch — not a round 15000 that is 3x the worst case this code can
  // produce and that a regression removing the cap would never reach (it would
  // hang instead of return).
  const budgetMs = SETTLE_MS + DRAIN_CAP_MS + SETTLE_MS + LAUNCH_SLACK_MS;
  if (elapsed > budgetMs) {
    failures.push(
      `4 wall clock: ${elapsed}ms against a ${budgetMs}ms budget (settle ${SETTLE_MS} + drain cap ` +
        `${DRAIN_CAP_MS} + quiescence ${SETTLE_MS} + ${LAUNCH_SLACK_MS} for the browser) — the ` +
        `drain waited on a recurring timer`,
    );
  } else {
    console.log(
      `  EXPECT  ok  4 wall clock ${elapsed}ms within the ${budgetMs}ms the run's own windows ` +
        `allow (drain cap ${DRAIN_CAP_MS}ms is what stops it being unbounded)`,
    );
  }
}

try {
  await amplificationOverreach();
  await pageLoadObservation();
  await slowButCorrectCommit();
  await neverQuiet();
} finally {
  await Promise.all(servers.map((s) => s.close()));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} guard-walk expectation(s) failed: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nevery guard held");
}
