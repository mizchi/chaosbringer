/**
 * RED TEAM harness.
 *
 *   npx tsx redteam/attack.mts            # every hole
 *   npx tsx redteam/attack.mts A D        # selected holes
 *
 * For each hole: replay the plan(s) through the real oracle (`runPlans` +
 * `aggregateCoverage` + `modelRunPassed`) and print the verdict, then print
 * independent evidence that the app is nevertheless wrong — server-side
 * counters read from the Node process, or DOM facts the oracle never looks at.
 *
 * The buggy and fixed variants are both run wherever the divergence is the
 * proof: identical oracle verdict, different ground truth.
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
   * EVIDENCE ONLY. The plan expects no state, so nothing here is compared —
   * the runner just records it. That is the hole: the model's vocabulary is
   * labels, so there is nothing for it to assert about the rendered page.
   */
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({
      state: document.getElementById("app")!.dataset.state!,
      summaryText: document.getElementById("summary")!.textContent!.replace(/\s+/g, " ").trim(),
      payEnabled: !(document.getElementById("pay") as HTMLButtonElement).disabled,
    })),
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
    console.log(`  EVIDENCE observed(uncompared)=${JSON.stringify(results[0]!.observed.state)}`);
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
    console.log(
      `  PROOF   variant=${fixed ? "fixed" : "buggy"} data-state=${state} payEnabled=${payEnabled} ` +
        `charges=${JSON.stringify(effects.charges)}`,
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
    telemetry: { urlPattern: /\/api\/telemetry$/, methods: ["POST"] },
  },
  action: async (page: import("playwright").Page) => {
    await page.getByRole("button", { name: "Start" }).click();
  },
  uiProbe: async (page: import("playwright").Page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  /** EVIDENCE ONLY: the plan expects no state, so nothing here is compared. */
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({ session: (window as unknown as { __SESSION__: string }).__SESSION__ })),
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
  console.log(`           observed.fired=${JSON.stringify(results[0]!.observed.fired)} ui=${results[0]!.observed.ui}`);

  // Control: every plan that actually injects something does catch it.
  const others = ["cart-rejected__shipping-fulfilled", "cart-hung__shipping-fulfilled"].map(gridPlan);
  const controls = await runPlans(others, { ...gridBridge, baseUrl: `${server.url}/fake` });
  console.log("  CONTROL  the same page against plans that do inject:");
  console.log(verdict(controls));
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
  /** EVIDENCE ONLY, as in hole A: the plan expects no state. */
  stateProbe: async (page: import("playwright").Page) =>
    page.evaluate(() => ({
      typed: (document.getElementById("q") as HTMLInputElement).value,
      rendered: document.getElementById("shown")!.dataset.q,
      text: document.getElementById("shown")!.textContent,
    })),
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
    console.log(`  PROOF   observed(uncompared)=${JSON.stringify(results[0]!.observed.state)}`);
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
        `(retry fires 900ms after the action; settleMs=400)`,
    );
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
