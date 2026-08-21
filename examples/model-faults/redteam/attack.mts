/**
 * RED TEAM harness.
 *
 *   npx tsx redteam/attack.mts            # every hole
 *   npx tsx redteam/attack.mts A D        # selected holes
 *
 * For each hole: replay the plan(s) through the real oracle (`runPlans` +
 * `aggregateCoverage` + `modelRunPassed`) and print the verdict, then print
 * independent evidence about the app — server-side counters read from the Node
 * process, or DOM facts the oracle never looked at when this file was written.
 *
 * The buggy and fixed variants are both run wherever the divergence is the
 * proof. Originally that divergence was the finding: identical oracle verdict,
 * different ground truth. Every hole is now closed, so the expectation is
 * inverted and *asserted* — `EXPECT` lines are checks, and the process exits
 * non-zero if the oracle stops catching a hole or starts failing a correct
 * app. The independent proofs still do not go through the oracle at all —
 * that is what keeps the assertions honest — but they are no longer only
 * printed: each one now states its own claim as an `assert`, because a
 * `console.log` of the ground truth stops being true silently, and these are
 * the lines a reader trusts most precisely because they bypass the oracle.
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  aggregateCoverage,
  modelRunPassed,
  resolvePlanTiming,
  runPlans,
  validatePlan,
  type FaultPlan,
  type PlanRunResult,
} from "chaosbringer";
import gridBridge from "../model/bridge.mjs";
import { allSessions, readEffects, startServer, type StartedServer } from "./server.js";

const profile = JSON.parse(
  readFileSync(new URL("../model/profile.json", import.meta.url), "utf8"),
);

const only = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
const want = (id: string) => only.size === 0 || only.has(id);

function plan(file: string): FaultPlan {
  const p = JSON.parse(readFileSync(new URL(`./plans/${file}`, import.meta.url), "utf8")) as FaultPlan;
  validatePlan(p);
  return p;
}

function gridPlan(name: string): FaultPlan {
  return JSON.parse(
    readFileSync(new URL(`../model/plans/${name}.plan.json`, import.meta.url), "utf8"),
  ) as FaultPlan;
}

function verdict(results: PlanRunResult[]): string {
  const coverage = aggregateCoverage(results);
  const keys = results.flatMap((r) => r.mismatches.map((m) => `${m.plan}/${m.field}: ${m.detail}`));
  return [
    `  ORACLE  mismatches=${coverage.mismatches.length} modelRunPassed=${modelRunPassed(coverage)} ` +
      `plansRun=${coverage.plansRun} notExercised=[${coverage.plansNotExercised.join(",")}]`,
    ...keys.map((k) => `          ! ${k}`),
  ].join("\n");
}

const failures: string[] = [];

/**
 * Assert the oracle's verdict on one run.
 *
 * `fields` is the exact multiset of mismatch fields expected, sorted — not a
 * subset, so a fix that starts reporting something extra shows up here rather
 * than hiding behind a passing "at least this failed".
 */
function expectVerdict(label: string, results: PlanRunResult[], fields: string[]): void {
  const coverage = aggregateCoverage(results);
  const got = results.flatMap((r) => r.mismatches.map((m) => m.field)).sort();
  const want = [...fields].sort();
  const passed = modelRunPassed(coverage);
  const wantPassed = fields.length === 0 && coverage.plansNotExercised.length === 0;
  const ok = JSON.stringify(got) === JSON.stringify(want) && passed === wantPassed;
  console.log(
    `  EXPECT  ${ok ? "ok" : "FAILED"}  ${label}: fields=${JSON.stringify(got)} ` +
      `(want ${JSON.stringify(want)}), modelRunPassed=${passed}`,
  );
  if (!ok) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/**
 * The independent proofs, as checks. `expectVerdict` above judges the oracle;
 * this judges the *evidence* — the server's own ledger, a DOM read, a raw
 * Playwright run — so a hole whose ground truth quietly stops being true fails
 * here instead of printing differently and passing.
 */
function proof(label: string, cond: boolean, detail: string): void {
  console.log(`  PROOF   ${cond ? "ok" : "FAILED"}  ${label}: ${detail}`);
  if (!cond) failures.push(`${label}: ${detail}`);
}

function fieldsOf(results: PlanRunResult[]): string[] {
  return results.flatMap((r) => r.mismatches.map((m) => m.field)).sort();
}

function firedStats(r: PlanRunResult): string {
  const rows = [
    ...(r.report?.runtimeFaults ?? []).map((s) => `runtime ${s.rule} matched=${s.matched} fired=${s.fired}`),
    ...(r.report?.faultInjections ?? []).map((s) => `network ${s.rule} matched=${s.matched} injected=${s.injected}`),
  ];
  return rows.map((x) => `          · ${x}`).join("\n");
}

const servers: StartedServer[] = [];
async function boot(fixed: boolean): Promise<StartedServer> {
  const s = await startServer(0, fixed);
  servers.push(s);
  return s;
}

/** The session the run just created (each page load mints one). */
function lastSession(): string {
  const all = allSessions();
  return all[all.length - 1]!;
}

// =====================================================================
// HOLE A — right label, wrong page
// =====================================================================
const bridgeA = {
  rules: { quote: /\/api\/quote$/ },
  action: async (page: import("playwright").Page) => {
    await page.getByRole("button", { name: "Refresh price" }).click();
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  /**
   * Recorded either way, and still the raw evidence the report quotes. What
   * changed is that the label no longer stands alone: `uiInvariants.error`
   * below says what `error` *means* on this page, and the runner checks it.
   */
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({
      state: document.getElementById("app")!.dataset.state!,
      summaryText: document.getElementById("summary")!.textContent!.replace(/\s+/g, " ").trim(),
      payEnabled: !(document.getElementById("pay") as HTMLButtonElement).disabled,
    })),
  /**
   * The app's own contract for its error state, written once in the bridge
   * rather than per plan: a price we could not revalidate is not a price, so
   * it must not be on screen and must not be payable.
   */
  uiInvariants: {
    error: async (page: import("playwright").Page) =>
      page.evaluate(() => {
        const problems: string[] = [];
        if (document.getElementById("summary")!.textContent!.trim() !== "") {
          problems.push("#summary still shows the quote from before the failed refresh");
        }
        if (!(document.getElementById("pay") as HTMLButtonElement).disabled) {
          problems.push("#pay is still enabled");
        }
        return problems.join("; ");
      }),
  },
  settleMs: 400,
};

async function holeA(): Promise<void> {
  console.log("\n=== HOLE A: right label, wrong page (stale money behind an error banner) ===");
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const results = await runPlans([plan("A-quote-refresh-rejected.plan.json")], {
      ...bridgeA,
      baseUrl: `${server.url}/quote`,
    });
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"}`);
    console.log(verdict(results));
    console.log(`  EVIDENCE observed=${JSON.stringify(results[0]!.observed.state)}`);
    // The label was always right; what the label *promises* is what fails.
    expectVerdict(`A ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["uiInvariant"]);
  }

  // Independent proof, no chaosbringer involved: drive the page with raw
  // Playwright, fail the refresh, then click Pay and read what the backend got.
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    let calls = 0;
    await page.route("**/api/quote", async (route) => {
      calls += 1;
      if (calls >= 2) await route.abort("failed");
      else await route.continue();
    });
    await page.goto(`${server.url}/quote`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Refresh price" }).click();
    await page.waitForTimeout(300);
    const state = await page.locator("#app").getAttribute("data-state");
    const payEnabled = await page.locator("#pay").isEnabled();
    if (payEnabled) await page.locator("#pay").click();
    await page.waitForTimeout(200);
    const session = await page.evaluate(() => (window as unknown as { __SESSION__: string }).__SESSION__);
    const effects = readEffects(session);
    // The whole point of hole A: the label was right and the money moved
    // anyway. Both halves are asserted — a page that stops charging and a
    // backend that stops recording the charge read identically in a print.
    proof(
      `A ${fixed ? "fixed" : "buggy"} the error banner ${fixed ? "disables" : "does not disable"} paying`,
      state === "error" &&
        payEnabled === !fixed &&
        effects.charges.length === (fixed ? 0 : 1) &&
        (fixed || effects.charges[0]!.appState === "error"),
      `data-state=${state} payEnabled=${payEnabled} charges=${JSON.stringify(effects.charges)}`,
    );
    await browser.close();
  }
}

// =====================================================================
// HOLE B — amplification is measured and discarded
// =====================================================================
const bridgeB = {
  rules: {
    feed: /\/api\/feed$/,
    // `(\?|$)` rather than `$`: the `+calls` run below states expect.calls on
    // this operation, and there the pattern defines the number being asserted
    // rather than selecting requests for it — a beacon with a cache-buster
    // would be neither faulted nor counted. The runner refuses the anchored
    // form for exactly that reason.
    telemetry: { urlPattern: /\/api\/telemetry(\?|$)/, methods: ["POST"] },
  },
  action: async (page: import("playwright").Page) => {
    await page.getByRole("button", { name: "Start" }).click();
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  /** Carries the session id so the harness can read the server's own counter. */
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({ session: (window as unknown as { __SESSION__: string }).__SESSION__ })),
  /**
   * This model accounts for every call on both URLs (the feed is fetched once
   * per Start, the beacon once per heartbeat), so the schedule's occurrence
   * span is a real upper bound and comparing against it is sound. Opt-in,
   * because against a model written for one action on a page that also
   * fetches on load it would not be.
   */
  checkAmplification: true,
  settleMs: 700,
};

async function holeB(): Promise<void> {
  console.log("\n=== HOLE B: request amplification is measured, then discarded ===");
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const results = await runPlans([plan("B-telemetry-first-500.plan.json")], {
      ...bridgeB,
      baseUrl: `${server.url}/poll`,
    });
    const effects = readEffects(String(results[0]!.observed.state!.session));
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"} (heartbeat interval ${fixed ? "60_000ms" : "60ms"})`);
    console.log(verdict(results));
    console.log(firedStats(results[0]!));
    console.log(`  PROOF   POST /api/telemetry reached the server ${effects.telemetry}x in one settle window`);
    // The beacon flood is the phenomenon; without it the oracle's
    // `amplification` verdict below is about nothing.
    proof(
      `B ${fixed ? "fixed" : "buggy"} the heartbeat ${fixed ? "does not flood" : "floods"} the endpoint`,
      fixed ? effects.telemetry <= 1 : effects.telemetry > 1,
      `${effects.telemetry} POST(s) in one ${bridgeB.settleMs}ms window at a ` +
        `${fixed ? "60_000" : "60"}ms interval`,
    );
    expectVerdict(`B ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["amplification"]);
  }

  // The same thing without the bridge flag: a plan that states the call count
  // itself. `expect.calls` is always checked, because it is the model talking.
  console.log("\n  same hole via the plan's own `expect.calls`, no bridge flag:");
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const base = plan("B-telemetry-first-500.plan.json");
    const withCalls: FaultPlan = {
      ...base,
      name: `${base.name}+calls`,
      expect: { ...base.expect, calls: { telemetry: 1 } },
    };
    validatePlan(withCalls);
    const { checkAmplification: _off, ...bridge } = bridgeB;
    const results = await runPlans([withCalls], { ...bridge, baseUrl: `${server.url}/poll` });
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"}`);
    console.log(verdict(results));
    expectVerdict(`B/calls ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["amplification"]);
  }
}

// =====================================================================
// HOLE C — a plan whose every step is `pass` asserts nothing
// =====================================================================
async function holeC(): Promise<void> {
  console.log("\n=== HOLE C: the happy-path plan is vacuous (no injections = nothing enforced) ===");
  const server = await boot(false);
  const happy = gridPlan("cart-fulfilled__shipping-fulfilled");
  // The sibling example's own bridge, unchanged, against a page that renders
  // a cached success and never calls either API.
  const results = await runPlans([happy], { ...gridBridge, baseUrl: `${server.url}/fake` });
  console.log(`\n  plan=${happy.name} (both steps "pass") against a page that issues zero requests`);
  console.log(verdict(results));
  console.log(`  EVIDENCE requests seen by the app's own endpoints: /api/cart and /api/shipping do not exist on this server`);
  console.log(
    `           observed.matched=${JSON.stringify(results[0]!.observed.matched)} ui=${results[0]!.observed.ui}`,
  );
  // Two rules the plan says pass, neither of them ever called.
  expectVerdict("C fake page", results, ["injection", "injection"]);

  // Control: every plan that actually injects something does catch it.
  const others = ["cart-rejected__shipping-fulfilled", "cart-hung__shipping-fulfilled"].map(gridPlan);
  const controls = await runPlans(others, { ...gridBridge, baseUrl: `${server.url}/fake` });
  console.log("  CONTROL  the same page against plans that do inject:");
  console.log(verdict(controls));
  // The control is what makes hole C a finding rather than a coincidence: the
  // same silent page, and every plan that injects something is caught. It ran
  // and printed for one round without asserting anything at all.
  proof(
    "C control: every injecting plan against the same silent page is caught",
    controls.length === 2 &&
      controls.every((r) => r.mismatches.some((m) => m.field === "injection")) &&
      fieldsOf(controls).length === 4,
    `fields=${JSON.stringify(fieldsOf(controls))} across ${controls.length} plan(s) — ` +
      `an injection that never fired plus the label it therefore never produced`,
  );
}

// =====================================================================
// HOLE D — the state probe is a single early snapshot
// =====================================================================
const bridgeD = {
  rules: { order: { urlPattern: /\/api\/rt\/order$/, methods: ["POST"] } },
  action: async (page: import("playwright").Page) => {
    await page.getByRole("button", { name: "Place order" }).click();
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(async () => {
      const session = (window as unknown as { __SESSION__: string }).__SESSION__;
      const res = await fetch(`/api/rt/orders/count?session=${encodeURIComponent(session)}`);
      const data = (await res.json()) as { orders: number };
      return { orders: data.orders, session };
    }),
  settleMs: 700,
};

async function holeD(): Promise<void> {
  console.log("\n=== HOLE D: the state probe is a snapshot too (duplicate write commits after it) ===");
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const results = await runPlans([plan("D-order-rejectAfter__then-fulfil.plan.json")], {
      ...bridgeD,
      baseUrl: `${server.url}/order`,
    });
    const session = String(results[0]!.observed.state!.session);
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"}`);
    console.log(verdict(results));
    console.log(`  probe read at settleMs: ${JSON.stringify(results[0]!.observed.state)}`);
    // Wait past the backend's commit latency and ask again.
    await new Promise((r) => setTimeout(r, 1200));
    const effects = readEffects(session);
    console.log(
      `  PROOF   after the backend finished committing: orders=${effects.orders.size} ` +
        `(POSTs accepted=${effects.orderPosts}) — the contract is exactly 1 order per intent`,
    );
    // Ground truth, read after the commit latency the probe cannot wait out:
    // two POSTs in both variants, and the idempotency key is what decides
    // whether they become one order or two.
    proof(
      `D ${fixed ? "fixed" : "buggy"} the retried write became ${fixed ? "one order" : "two"}`,
      effects.orderPosts === 2 && effects.orders.size === (fixed ? 1 : 2),
      `orders=${effects.orders.size} from ${effects.orderPosts} accepted POST(s)`,
    );
    expectVerdict(`D ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["state"]);
    // …and the divergence the oracle used to miss is now in the report: the
    // probe read the predicted value, the settled read did not.
    if (!fixed) {
      const observed = results[0]!.observed;
      console.log(
        `  DETAIL  probe=${JSON.stringify(observed.state?.orders)} ` +
          `settled=${JSON.stringify(observed.stateSettled?.orders)}`,
      );
    }
  }
}

// =====================================================================
// HOLE E — stale response wins; label is right, content is wrong
// =====================================================================
const bridgeE = {
  rules: { search: /\/api\/search/ },
  action: async (page: import("playwright").Page) => {
    await page.locator("#q").fill("a");
    await page.waitForTimeout(80);
    await page.locator("#q").fill("ab");
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({
      typed: (document.getElementById("q") as HTMLInputElement).value,
      rendered: document.getElementById("shown")!.dataset.q,
      text: document.getElementById("shown")!.textContent,
    })),
  /**
   * What `ready` means on a search page: the results on screen belong to the
   * query in the box. The oracle cannot name *which response's body* must be
   * rendered — that is still outside its vocabulary — but the app exposes the
   * correlation itself (`#shown[data-q]`), and an app that does can have it
   * checked.
   */
  uiInvariants: {
    ready: async (page: import("playwright").Page) =>
      page.evaluate(() => {
        const typed = (document.getElementById("q") as HTMLInputElement).value;
        const rendered = document.getElementById("shown")!.dataset.q;
        return typed === rendered
          ? ""
          : `showing results for "${rendered}" while the input reads "${typed}"`;
      }),
  },
  appDeadlineMs: 600,
  timingProfile: profile,
};

async function holeE(): Promise<void> {
  console.log("\n=== HOLE E: out-of-order responses (right label, wrong content) ===");
  const timing = resolvePlanTiming({ appDeadlineMs: 600, timingProfile: profile });
  console.log(
    `  timing: slow-ok delay=${timing.delays!.fastMs}ms, probe at settleMs=${timing.settleMs}ms ` +
      `(app deadline 600ms) — so the stale response lands before the probe`,
  );
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const results = await runPlans([plan("E-search-stale-wins.plan.json")], {
      ...bridgeE,
      baseUrl: `${server.url}/race`,
    });
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"}`);
    console.log(verdict(results));
    console.log(`  PROOF   observed=${JSON.stringify(results[0]!.observed.state)}`);
    // The phenomenon, independent of the verdict: what is on screen belongs to
    // the earlier query in the buggy variant and to the typed one in the fixed
    // variant. Both reads come from the page, not from the oracle.
    const seen = results[0]!.observed.state as { typed: string; rendered: string };
    proof(
      `E ${fixed ? "fixed" : "buggy"} the results on screen are ${fixed ? "" : "not "}the ones asked for`,
      seen.typed === "ab" && (fixed ? seen.rendered === "ab" : seen.rendered === "a"),
      `typed="${seen.typed}" rendered="${seen.rendered}"`,
    );
    expectVerdict(`E ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["uiInvariant"]);
  }
}

// =====================================================================
// HOLE F — an unhandled rejection that fires after the probe
// =====================================================================
const bridgeF = {
  rules: { quote: /\/api\/quote$/ },
  action: async (page: import("playwright").Page) => {
    await page.getByRole("button", { name: "Load" }).click();
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  settleMs: 400,
};

async function holeF(): Promise<void> {
  console.log("\n=== HOLE F: unhandledRejection is only watched until the probe ===");
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const results = await runPlans([plan("F-late-unhandled.plan.json")], {
      ...bridgeF,
      baseUrl: `${server.url}/late`,
    });
    console.log(`\n  variant=${fixed ? "fixed" : "buggy"}`);
    console.log(verdict(results));
    console.log(
      `  observed.unhandledRejection=${results[0]!.observed.unhandledRejection} ` +
        `late=${results[0]!.observed.lateUnhandledRejection} ` +
        `(retry fires 900ms after the action; settleMs=400)`,
    );
    expectVerdict(`F ${fixed ? "fixed" : "buggy"}`, results, fixed ? [] : ["unhandledRejection@late"]);
  }

  // Independent proof: same page, same fault, a tab that stays open.
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __esc: string[] }).__esc = [];
      window.addEventListener("unhandledrejection", (e) => {
        (window as unknown as { __esc: string[] }).__esc.push(String((e as PromiseRejectionEvent).reason));
      });
    });
    await page.route("**/api/quote", (route) => route.abort("failed"));
    await page.goto(`${server.url}/late`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Load" }).click();
    await page.waitForTimeout(400);
    const atProbe = await page.evaluate(() => (window as unknown as { __esc: string[] }).__esc.length);
    await page.waitForTimeout(1400);
    const later = await page.evaluate(() => (window as unknown as { __esc: string[] }).__esc);
    console.log(
      `  PROOF   variant=${fixed ? "fixed" : "buggy"} escaping rejections at 400ms=${atProbe}, ` +
        `at 1800ms=${later.length} ${JSON.stringify(later)}`,
    );
    // The hole is the *timing*: nothing has escaped at the probe either way,
    // and only the buggy page produces one afterwards. A run where the
    // rejection already escaped at 400ms would be measuring something else.
    proof(
      `F ${fixed ? "fixed" : "buggy"} the rejection escapes ${fixed ? "never" : "after the probe"}`,
      atProbe === 0 && later.length === (fixed ? 0 : 1),
      `at 400ms=${atProbe}, at 1800ms=${later.length} ${JSON.stringify(later)}`,
    );
    await browser.close();
  }
}

// =====================================================================
// REFUTATION — a non-fetch transport (XHR): false pass, or honest report?
// =====================================================================
async function refutationXhr(): Promise<void> {
  console.log("\n=== REFUTATION: `reject` against an XMLHttpRequest app ===");
  const server = await boot(false);
  const results = await runPlans([plan("R-xhr-rejected.plan.json")], {
    rules: { feed: /\/api\/feed$/ },
    action: async (page: import("playwright").Page) => {
      await page.getByRole("button", { name: "Load" }).click();
    },
    uiProbe: async (page: import("playwright").Page) => {
      const state = await page.locator("#app").getAttribute("data-state");
      return state === "loading" ? "stuck" : (state ?? "unknown");
    },
    settleMs: 400,
    baseUrl: `${server.url}/xhr`,
  });
  console.log(verdict(results));
  console.log(firedStats(results[0]!));
  // Unchanged by the fixes, and it must stay that way: an app the plan cannot
  // drive is reported as not exercised, never as a pass.
  expectVerdict("R xhr", results, ["injection", "ui"]);
}

const holes: Array<[string, () => Promise<void>]> = [
  ["A", holeA],
  ["B", holeB],
  ["C", holeC],
  ["D", holeD],
  ["E", holeE],
  ["F", holeF],
  ["R", refutationXhr],
];

try {
  for (const [id, run] of holes) {
    if (!want(id)) continue;
    await run();
  }
} finally {
  await Promise.all(servers.map((s) => s.close()));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} expectation(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nall expectations held");
}
