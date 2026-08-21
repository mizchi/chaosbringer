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
    settleMs: 400,
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
    settleMs: 400,
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
  console.log(
    `  probe=${JSON.stringify(o.state?.orders)} settled=${JSON.stringify(o.stateSettled?.orders)}` +
      ` — drifted, and converged on the predicted value`,
  );
  expectVerdict("3 slow commit, correct result", results, []);
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
    settleMs: 400,
    baseUrl: `${server.url}/poll`,
  });
  const elapsed = Date.now() - startedAt;
  console.log(
    `  pendingAsync=${JSON.stringify(results[0]!.observed.pendingAsync)} wallClock=${elapsed}ms`,
  );
  expectVerdict("4 uncleared interval", results, []);
  if (elapsed > 15000) failures.push("4 wall clock: the drain waited on a recurring timer");
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
