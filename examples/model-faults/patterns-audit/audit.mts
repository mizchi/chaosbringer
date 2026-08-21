/**
 * PATTERNS AUDIT harness.
 *
 *   cd examples/model-faults && npx tsx patterns-audit/audit.mts        # everything
 *   cd examples/model-faults && npx tsx patterns-audit/audit.mts F2 F4  # selected
 *
 * The target is not the oracle — that was audited in `../redteam/` and the
 * holes are closed. The target is the claim each shipped pattern makes about
 * itself: *the buggy variant produces the specific mismatch this pattern exists
 * for, and the fixed variant produces none.*
 *
 * Every finding below is proved the same way the previous pass proved its
 * holes: with a divergence. The pattern's **own committed plans** and its
 * **own bridge**, both unmodified and imported straight from
 * `../patterns/<name>/`, are replayed against a page carrying one bug of that
 * pattern's own class. The oracle's verdict on the wrong app is then compared
 * with its verdict on the right one, and an independent measurement — the audit
 * server's raw request ledger, a DOM read, a raw Playwright run — says which
 * of the two the app actually was.
 *
 * `EXPECT` lines are assertions. `FINDING` means the oracle's verdict was
 * identical on both variants (the hole). `REFUTED` means the pattern caught the
 * bug and the hypothesis was wrong; those are printed with the output that
 * refuted them rather than deleted.
 *
 * ## After the fixes — what this file asserts now
 *
 * Six of the eight findings are closed, so this harness asserts the *closure*:
 * the same app shapes, the same committed plans, and now a mismatch where there
 * used to be none. `CLOSED` marks a finding whose two variants the oracle can
 * finally tell apart. What is deliberately unchanged:
 *
 *   - **F5 stands.** The probe is still parameterised by a value the page
 *     supplies, and no fix here was sound: reading a run-scoped ledger needs
 *     the app under test to expose one. It is documented as a limit in
 *     `docs/recipes/model-driven-faults.md` instead, and this file keeps
 *     reproducing it.
 *   - **R1 and R2 stay refuted**, with their output.
 *   - **F2's two variants still produce the same *shape* of verdict**, and that
 *     is the closure: both now fail. The escape was "extra traffic, correct
 *     count", and the count now moves with the traffic (249 vs 12 where it was
 *     9 vs 9). The red team's own "fixed" page resumes with a cursor too, just
 *     boundedly, and those requests are requests the model never described — so
 *     it fails honestly rather than passing blindly.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  aggregateCoverage,
  modelRunPassed,
  resolvePlanTiming,
  runPlans,
  validateCallCountRules,
  validatePlan,
  type FaultPlan,
  type PlanRunResult,
} from "chaosbringer";
import optimisticBridge from "../patterns/optimistic-rollback/bridge.mjs";
import paginationBridge from "../patterns/pagination-order/bridge.mjs";
import reconnectBridge from "../patterns/reconnect-budget/bridge.mjs";
import retryBridge from "../patterns/retry-idempotency/bridge.mjs";
import tokenBridge from "../patterns/token-refresh/bridge.mjs";
import timeoutBridge from "../patterns/timeout-ladder/bridge.mjs";
import { callsOn, resetLedger, startServer, type StartedServer } from "./server.js";

const only = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
const want = (id: string) => only.size === 0 || only.has(id);

const failures: string[] = [];
const servers: StartedServer[] = [];

async function boot(fixed: boolean): Promise<StartedServer> {
  const s = await startServer(0, fixed);
  servers.push(s);
  return s;
}

/** A shipped plan, loaded from the pattern's own committed `plans/` directory. */
function shippedPlan(pattern: string, name: string): FaultPlan {
  const plan = JSON.parse(
    readFileSync(new URL(`../patterns/${pattern}/plans/${name}.plan.json`, import.meta.url), "utf8"),
  ) as FaultPlan;
  validatePlan(plan);
  return plan;
}

function shippedPlans(pattern: string, names: string[]): FaultPlan[] {
  return names.map((n) => shippedPlan(pattern, n));
}

function verdict(results: PlanRunResult[]): string {
  const coverage = aggregateCoverage(results);
  const lines = results.flatMap((r) =>
    r.mismatches.map((m) => `          ! ${m.plan}/${m.field}: ${m.detail}`),
  );
  return [
    `  ORACLE  mismatches=${coverage.mismatches.length} modelRunPassed=${modelRunPassed(coverage)} ` +
      `plansRun=${coverage.plansRun} notExercised=[${coverage.plansNotExercised.join(",")}]`,
    ...lines,
  ].join("\n");
}

function fields(results: PlanRunResult[]): string[] {
  return results.flatMap((r) => r.mismatches.map((m) => m.field)).sort();
}

function expectFields(label: string, results: PlanRunResult[], wantFields: string[]): void {
  const got = fields(results);
  const ok = JSON.stringify(got) === JSON.stringify([...wantFields].sort());
  console.log(
    `  EXPECT  ${ok ? "ok" : "FAILED"}  ${label}: fields=${JSON.stringify(got)} ` +
      `(want ${JSON.stringify([...wantFields].sort())})`,
  );
  if (!ok) failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(wantFields)}`);
}

/** The finding itself: the oracle could not tell the two apps apart. */
function expectIndistinguishable(label: string, a: PlanRunResult[], b: PlanRunResult[]): void {
  const fa = JSON.stringify(fields(a));
  const fb = JSON.stringify(fields(b));
  const ok = fa === fb;
  console.log(
    `  FINDING ${ok ? "confirmed" : "NOT CONFIRMED"}  ${label}: buggy=${fa} fixed=${fb}`,
  );
  if (!ok) failures.push(`${label}: verdicts differed (${fa} vs ${fb})`);
}

/**
 * The closure: the same two apps, and now the oracle separates them. The
 * opposite assertion to `expectIndistinguishable`, kept next to it on purpose —
 * a finding is closed when the verdicts diverge, and if they ever collapse back
 * into agreement this process exits non-zero again.
 */
function expectDistinguishable(
  label: string,
  a: PlanRunResult[],
  b: PlanRunResult[],
  names: [string, string] = ["buggy", "fixed"],
): void {
  const fa = JSON.stringify(fields(a));
  const fb = JSON.stringify(fields(b));
  const ok = fa !== fb && fields(a).length > 0;
  console.log(
    `  CLOSED  ${ok ? "yes" : "NO — THE HOLE IS BACK"}  ${label}: ` +
      `${names[0]}=${fa} ${names[1]}=${fb}`,
  );
  if (!ok) failures.push(`${label}: the oracle still cannot tell the two apps apart (${fa} vs ${fb})`);
}

function assert(label: string, cond: boolean, detail: string): void {
  console.log(`  PROOF   ${cond ? "ok" : "FAILED"}  ${label}: ${detail}`);
  if (!cond) failures.push(`${label}: ${detail}`);
}

// =====================================================================
// F1 — optimistic-rollback: expect.calls proves the request, not the reading
// =====================================================================
async function F1(): Promise<void> {
  console.log(
    "\n=== F1  optimistic-rollback: the reconcile read that nobody reads ===\n" +
      "    the pattern's own four plans, its own bridge, against an app whose\n" +
      "    reconcile GET is issued and discarded\n" +
      "    CLOSED: the bridge now compares the rows' data-id against the server's\n" +
      "    own ids (/api/notes/count, which neither rule matches, so the check\n" +
      "    cannot inflate the count it sits next to). expect.calls proves the\n" +
      "    request; only identity proves the app read the answer.",
  );
  const plans = shippedPlans("optimistic-rollback", [
    "write-fulfil",
    "write-rejectBefore",
    "write-rejectAfter",
    "write-serverError",
  ]);

  const runs: Record<string, PlanRunResult[]> = {};
  const dom: Record<string, unknown> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "fixed" : "buggy";
    // The `fixed` flag reaches the page as window.__AUDIT_FIXED__; every
    // /api/... route the bridge and the probe touch is the shipped one and does
    // not depend on it.
    const server = await boot(fixed);
    resetLedger();
    runs[label] = await runPlans(plans, {
      ...optimisticBridge,
      baseUrl: `${server.url}/audit/optimistic`,
    });
    console.log(`\n  variant=${label} (reconcile ${fixed ? "rendered" : "discarded"})`);
    console.log(verdict(runs[label]!));
    console.log(
      `          list GETs on /api/notes seen by the server: ${callsOn("/api/notes").length}` +
        ` (page load + reconcile, per plan)`,
    );

    // Independent proof: replay the ambiguous case by hand and read both the
    // DOM and the server, with no oracle in the loop.
    dom[label] = await ambiguousByHand(server.url);
  }

  // write-rejectAfter only: the other three plans roll the row back and then
  // read the list, so screen and server agree in both variants — which is what
  // keeps this from being a check that fires on any failure.
  expectFields("F1 buggy (all four plans)", runs.buggy!, ["uiInvariant"]);
  expectFields("F1 fixed (all four plans)", runs.fixed!, []);
  expectDistinguishable("F1 optimistic-rollback", runs.buggy!, runs.fixed!);
  assert(
    "F1 the mismatch names the id nobody else can address",
    runs.buggy!.some((r) =>
      r.mismatches.some((m) => /screen shows note id\(s\) \[local-1\]/.test(m.detail)),
    ),
    runs.buggy!.flatMap((r) => r.mismatches.map((m) => `${r.plan.name}: ${m.detail}`)).join(" | ") ||
      "(no mismatch)",
  );

  const b = dom.buggy as { rows: Array<{ text: string; id: string | null }>; server: unknown };
  const f = dom.fixed as { rows: Array<{ text: string; id: string | null }>; server: unknown };
  console.log(`\n  INDEPENDENT (raw Playwright, res.json() aborted after the commit)`);
  console.log(`    buggy  rows=${JSON.stringify(b.rows)} server=${JSON.stringify(b.server)}`);
  console.log(`    fixed  rows=${JSON.stringify(f.rows)} server=${JSON.stringify(f.server)}`);
  assert(
    "F1 the discarded reconcile shows a row the server never named",
    b.rows.length === 1 && b.rows[0]!.id!.startsWith("local-"),
    `buggy row id=${b.rows[0]?.id} while the server holds ${JSON.stringify(b.server)}`,
  );
  assert(
    "F1 the read reconcile shows the server's own row",
    f.rows.length === 1 && f.rows[0]!.id === "note-1",
    `fixed row id=${f.rows[0]?.id}`,
  );
}

/**
 * The `write-rejectAfter` case without chaosbringer: let the POST commit, then
 * break the response body, then read the DOM and the server separately.
 */
async function ambiguousByHand(
  base: string,
): Promise<{ rows: Array<{ text: string; id: string | null }>; server: unknown }> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let posted = false;
  await page.route("**/api/notes", async (route) => {
    if (route.request().method() === "POST" && !posted) {
      posted = true;
      // Let the server commit, then hand the page a body it cannot read.
      const res = await route.fetch();
      await res.body();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{ not json" });
      return;
    }
    await route.continue();
  });
  await page.goto(`${base}/audit/optimistic`);
  await page.getByRole("button", { name: "Add note" }).click();
  await page.waitForTimeout(700);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#notes li")].map((li) => ({
      text: li.textContent ?? "",
      id: (li as HTMLElement).dataset.id ?? null,
    })),
  );
  const session = await page.evaluate(() => (window as unknown as { __SESSION__: string }).__SESSION__);
  const server = await (await fetch(`${base}/api/notes?session=${encodeURIComponent(session)}`)).json();
  await browser.close();
  return { rows, server };
}

// =====================================================================
// F2 — reconnect-budget: the count that is the contract counts bare URLs only
// =====================================================================
async function F2(): Promise<void> {
  console.log(
    "\n=== F2  reconnect-budget: an anchored rule, and a resume loop with a cursor ===\n" +
      "    rules.stream WAS /\\/api\\/stream$/ — every request carrying a query\n" +
      "    string was neither faulted nor counted\n" +
      "    CLOSED: the rule is /\\/api\\/stream(\\?|$)/, and a `$`-anchored pattern on\n" +
      "    an operation a plan counts is now a pre-flight error. Note BOTH variants\n" +
      "    fail now: the red team's 'fixed' page resumes with a cursor too, just\n" +
      "    boundedly, and those are requests the model never described. The hole was\n" +
      "    'extra traffic, correct count'; the count now moves with the traffic.",
  );
  const plans = shippedPlans("reconnect-budget", [
    "connect-on-1",
    "connect-on-2",
    "connect-on-3",
    "budget-exhausted",
  ]);

  const runs: Record<string, PlanRunResult[]> = {};
  const seen: Record<string, { bare: number; withQuery: number; matched: number }> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "fixed" : "buggy";
    const server = await boot(fixed);
    resetLedger();
    runs[label] = await runPlans(plans, {
      ...reconnectBridge,
      baseUrl: `${server.url}/audit/stream`,
    });
    const calls = callsOn("/api/stream");
    seen[label] = {
      bare: calls.filter((c) => c.query === "").length,
      withQuery: calls.filter((c) => c.query !== "").length,
      matched: runs[label]!.reduce((n, r) => n + (r.observed.matched.stream ?? 0), 0),
    };
    console.log(`\n  variant=${label} (resume loop ${fixed ? "bounded" : "unbounded"})`);
    console.log(verdict(runs[label]!));
    console.log(
      `          expect.calls totals across the four plans: 1+2+3+3 = 9;` +
        ` observed.matched.stream summed = ${seen[label]!.matched}`,
    );
    console.log(
      `          server ledger: GET /api/stream bare=${seen[label]!.bare}` +
        ` with-query=${seen[label]!.withQuery}`,
    );
  }

  // Three of the four plans each report the resume loop as amplification; the
  // fourth (budget-exhausted) is the plan whose count the loop happened to
  // make come out right, and it is the reason the escape was dangerous.
  expectFields("F2 buggy (all four plans)", runs.buggy!, [
    "amplification",
    "amplification",
    "amplification",
  ]);
  expectFields("F2 fixed (all four plans)", runs.fixed!, [
    "amplification",
    "amplification",
    "amplification",
  ]);
  assert(
    "F2 the counted number now moves with the real one",
    // It used to be 9 against 9 while the wire carried 58 against 6.
    seen.buggy!.matched > seen.fixed!.matched + 20 &&
      // …and each count is within a client-side reject or two of the traffic
      // the server actually saw, rather than of the model's number.
      seen.buggy!.matched >= seen.buggy!.bare + seen.buggy!.withQuery &&
      seen.buggy!.matched <= seen.buggy!.bare + seen.buggy!.withQuery + 9,
    `matched ${seen.buggy!.matched} vs ${seen.fixed!.matched} (was 9 vs 9); ` +
      `real requests to /api/stream ${seen.buggy!.bare + seen.buggy!.withQuery} vs ` +
      `${seen.fixed!.bare + seen.fixed!.withQuery}`,
  );
  assert(
    "F2 the anchored form is refused before a browser launches",
    (() => {
      try {
        validateCallCountRules(shippedPlan("reconnect-budget", "budget-exhausted"), {
          stream: { urlPattern: /\/api\/stream$/, methods: ["GET"] },
        });
        return false;
      } catch (err) {
        return /\$`-anchored pattern/.test(err instanceof Error ? err.message : "");
      }
    })(),
    "validateCallCountRules refuses a $-anchored urlPattern on an operation a plan counts",
  );
}

// =====================================================================
// F3 — pagination-order: the invariant reads an app-derived index
// =====================================================================
async function F3(): Promise<void> {
  console.log(
    "\n=== F3  pagination-order: data-idx written from the render position ===\n" +
      "    the bridge's uiInvariants['*'] compared data-idx against its own sort\n" +
      "    CLOSED: it now correlates two independent sources first — the attribute\n" +
      "    against the row's own rendered `Post <idx>`, which comes from the\n" +
      "    payload — and only then checks ascending/unique. A position-derived\n" +
      "    attribute fails the first check wherever it disagrees with the content,\n" +
      "    which on this page is every plan whose pages did not arrive in order.",
  );
  const plans = shippedPlans("pagination-order", ["page1-fulfil", "page1-slow", "page1-rejectBefore"]);
  const timing = resolvePlanTiming({
    appDeadlineMs: paginationBridge.appDeadlineMs,
    timingProfile: paginationBridge.timingProfile,
  });
  console.log(
    `    timing: slow-ok delay=${timing.delays!.fastMs}ms, probe at settleMs=${timing.settleMs}ms ` +
      `(app deadline ${paginationBridge.appDeadlineMs}ms)`,
  );

  const runs: Record<string, PlanRunResult[]> = {};
  const rendered: Record<string, unknown> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "fixed" : "buggy";
    const server = await boot(fixed);
    runs[label] = await runPlans(plans, {
      ...paginationBridge,
      baseUrl: `${server.url}/audit/feed`,
      // The same probe the pattern uses, plus the text nobody compares. The
      // extra keys are recorded and never asserted (no plan names them), which
      // is how the evidence gets out without changing a single check.
      stateProbe: async (page) =>
        page.evaluate(() => ({
          items: document.querySelectorAll("#items li").length,
          idx: [...document.querySelectorAll("#items li")]
            .map((li) => (li as HTMLElement).dataset.idx)
            .join(","),
          text: [...document.querySelectorAll("#items li")].map((li) => li.textContent).join(","),
        })),
    });
    const raced = runs[label]!.find((r) => r.plan.name === "page1-slow")!;
    rendered[label] = raced.observed.state;
    console.log(`\n  variant=${label} (${fixed ? "render from page order" : "append on arrival"})`);
    console.log(verdict(runs[label]!));
    console.log(`          page1-slow observed: ${JSON.stringify(raced.observed.state)}`);
  }

  // buggy: page1-slow (rows 3,4,1,2 labelled 1,2,3,4) and page1-rejectBefore
  // (rows 3,4 labelled 1,2). fixed: page1-rejectBefore only — page 1 failed, so
  // even a correct render labels page 2's rows 1 and 2. That row is a true
  // violation of the corollary, not a false positive: this app's data-idx is
  // not derived from the response, so the ordering claim is unfalsifiable on it
  // either way. The shipped page passes both checks in both variants.
  expectFields("F3 buggy (all three plans)", runs.buggy!, ["uiInvariant", "uiInvariant"]);
  expectFields("F3 fixed (all three plans)", runs.fixed!, ["uiInvariant"]);
  expectDistinguishable("F3 pagination-order", runs.buggy!, runs.fixed!);
  assert(
    "F3 the mismatch says which row disagrees with its own content",
    runs.buggy!.some((r) =>
      r.mismatches.some((m) => /index does not match its own content/.test(m.detail)),
    ),
    runs.buggy!.flatMap((r) => r.mismatches.map((m) => `${r.plan.name}: ${m.detail}`)).join(" | ") ||
      "(no mismatch)",
  );
  const b = rendered.buggy as { idx: string; text: string };
  const f = rendered.fixed as { idx: string; text: string };
  assert(
    "F3 identical data-idx, reversed rows",
    b.idx === f.idx && b.text !== f.text,
    `buggy idx=[${b.idx}] text=[${b.text}] / fixed idx=[${f.idx}] text=[${f.text}]`,
  );
}

// =====================================================================
// F4 — timeout-ladder: a bound on the banner, not on the request
// =====================================================================
async function F4(): Promise<void> {
  console.log(
    "\n=== F4  timeout-ladder: Promise.race passes all three rungs ===\n" +
      "    the pattern's fixed direction is 'every rung passes once the request\n" +
      "    is bounded'; this bounds the UI and never cancels the request\n" +
      "    CLOSED: `ui` and `uiInvariants` get the symmetric second read after the\n" +
      "    observation window, and a label that was RIGHT at the probe and moved\n" +
      "    afterwards is reported as ui@late. A label that started wrong and\n" +
      "    converged is still not a bug — the unbound control below proves the\n" +
      "    rule is not just 'read it twice and complain'.",
  );
  const plans = shippedPlans("timeout-ladder", ["report-quick", "report-slow", "report-tooSlow"]);
  const timing = resolvePlanTiming({
    appDeadlineMs: timeoutBridge.appDeadlineMs,
    timingProfile: timeoutBridge.timingProfile,
  });
  console.log(
    `    timing: slow-ok=${timing.delays!.fastMs}ms slow-trip=${timing.delays!.slowMs}ms ` +
      `probe at settleMs=${timing.settleMs}ms, app deadline=${timeoutBridge.appDeadlineMs}ms`,
  );

  const runs: Record<string, PlanRunResult[]> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "race-bound" : "unbound (control)";
    const server = await boot(fixed);
    resetLedger();
    runs[fixed ? "fixed" : "buggy"] = await runPlans(plans, {
      ...timeoutBridge,
      baseUrl: `${server.url}/audit/slow`,
    });
    console.log(`\n  variant=${label}`);
    console.log(verdict(runs[fixed ? "fixed" : "buggy"]!));
  }

  // The control must still be caught, or this page proves nothing — and it must
  // be caught as ONE `ui` mismatch, not as `ui` plus `ui@late`: that page reads
  // "stuck" at the probe and "ready" afterwards, and doubling it up would make
  // one bug look like two.
  expectFields("F4 unbound control (report-tooSlow)", runs.buggy!, ["ui"]);
  expectFields("F4 Promise.race variant (all three rungs)", runs.fixed!, ["ui@late"]);
  expectDistinguishable("F4 timeout-ladder", runs.fixed!, runs.buggy!, [
    "race-bound (the app under audit)",
    "unbound control",
  ]);
  assert(
    "F4 the late mismatch names both labels and the window",
    runs.fixed!.some((r) =>
      r.mismatches.some(
        (m) => m.field === "ui@late" && /moved to "ready"/.test(m.detail) && r.observed.ui === "error",
      ),
    ),
    runs.fixed!.flatMap((r) => r.mismatches.map((m) => `${m.field}: ${m.detail}`)).join(" | ") ||
      "(no mismatch)",
  );

  // Independent: the same too-slow response, watched past the probe.
  const server = await boot(true);
  resetLedger();
  const flip = await watchPastProbe(server.url, timing.delays!.slowMs, timing.settleMs);
  console.log(
    `\n  INDEPENDENT (raw Playwright, ${timing.delays!.slowMs}ms delay, no chaosbringer)\n` +
      `    at ${timing.settleMs}ms (the oracle's only look): ${JSON.stringify(flip.atProbe)}\n` +
      `    at ${timing.delays!.slowMs + 400}ms:                    ${JSON.stringify(flip.after)}\n` +
      `    the abandoned request still reached the server: ${callsOn("/api/report").length}x`,
  );
  assert(
    "F4 the UI the oracle judged is not the UI the user ends up with",
    flip.atProbe.state === "error" && flip.after.state === "ready",
    `error at the probe, ${flip.after.state} afterwards ("${flip.after.banner}")`,
  );
}

async function watchPastProbe(
  base: string,
  delayMs: number,
  probeMs: number,
): Promise<{ atProbe: { state: string; banner: string }; after: { state: string; banner: string } }> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.route("**/api/report", async (route) => {
    await new Promise((r) => setTimeout(r, delayMs));
    await route.fallback();
  });
  await page.goto(`${base}/audit/slow`);
  const read = () =>
    page.evaluate(() => ({
      state: document.getElementById("app")!.dataset.state ?? "",
      banner: document.getElementById("banner")!.textContent ?? "",
    }));
  const t = Date.now();
  await page.getByRole("button", { name: "Load report" }).click();
  await page.waitForTimeout(probeMs);
  const atProbe = await read();
  await page.waitForTimeout(Math.max(0, delayMs + 400 - (Date.now() - t)));
  const after = await read();
  await browser.close();
  return { atProbe, after };
}

// =====================================================================
// F5 — retry-idempotency: the probe reads a bucket the page names
// =====================================================================
async function F5(): Promise<void> {
  console.log(
    "\n=== F5  retry-idempotency: expect.state reads a query the page composes ===\n" +
      "    stateProbe asks /api/orders/count?session=window.__SESSION__ — the\n" +
      "    same value the page sends as x-session",
  );
  const plans = shippedPlans("retry-idempotency", [
    "first-fulfil",
    "first-rejectAfter__then-fulfil",
    "first-rejectAfter__then-rejectAfter",
    "first-rejectBefore__then-fulfil",
  ]);

  const runs: Record<string, PlanRunResult[]> = {};
  const truth: Record<string, { posts: number; buckets: string[]; orders: number }> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "fixed" : "buggy";
    const server = await boot(fixed);
    resetLedger();
    runs[label] = await runPlans(plans, {
      ...retryBridge,
      baseUrl: `${server.url}/audit/retry`,
    });
    const posts = callsOn("/api/order", "POST");
    const buckets = [...new Set(posts.map((p) => `${p.session}|${p.key}`))];
    // Ground truth, read from the server per bucket rather than per page.
    let orders = 0;
    for (const s of new Set(posts.map((p) => p.session))) {
      const r = (await (
        await fetch(`${server.url}/api/orders/count?session=${encodeURIComponent(s)}`)
      ).json()) as { orders: number };
      orders += r.orders;
    }
    truth[label] = { posts: posts.length, buckets, orders };
    console.log(`\n  variant=${label} (retry ${fixed ? "keeps" : "re-mints"} the session)`);
    console.log(verdict(runs[label]!));
    const target = runs[label]!.find((r) => r.plan.name === "first-rejectAfter__then-fulfil")!;
    console.log(
      `          first-rejectAfter__then-fulfil: probe=${JSON.stringify(target.observed.state)} ` +
        `settled=${JSON.stringify(target.observed.stateSettled)} ui=${target.observed.ui}`,
    );
    console.log(
      `          server ledger: ${posts.length} POSTs, distinct (session|key) pairs=${buckets.length}, ` +
        `orders committed across every bucket=${orders}`,
    );
  }

  expectFields("F5 buggy (four plans)", runs.buggy!, []);
  expectFields("F5 fixed (four plans)", runs.fixed!, []);
  expectIndistinguishable("F5 retry-idempotency", runs.buggy!, runs.fixed!);
  assert(
    "F5 one intent, two committed orders, and the probe reads 1",
    truth.buggy!.orders > truth.fixed!.orders,
    `orders across all buckets: buggy=${truth.buggy!.orders} fixed=${truth.fixed!.orders} ` +
      `(POSTs ${truth.buggy!.posts} vs ${truth.fixed!.posts})`,
  );
}


// =====================================================================
// F6 — contract-forbids targets that no knob can reach (delegated, no browser)
// =====================================================================
async function F6(): Promise<void> {
  console.log(
    "\n=== F6  the contract-forbids targets a model checker can only answer one way ===\n" +
      "    CLOSED as tooling: the mechanism below is promoted into\n" +
      "    patterns/vacuity.mjs, every enumerate.sh calls it, and targets.txt now\n" +
      "    records `unreachable-live` or `unreachable-by-construction` per target\n" +
      "    instead of one word for both. The 9 remaining by-construction rows are\n" +
      "    labelled rather than deleted — each is a prompt to write the knob or\n" +
      "    drop the query, and reconnect-budget's headline property got the knob.",
  );
  // The red team's own script, unmodified: it is the measurement, and it still
  // reports which targets a witness could ever have answered.
  run(new URL("./model-vacuity.mts", import.meta.url));

  // …and the assertion the finding turns into: no `contract-forbids-*` row may
  // be recorded with the same word as its neighbours any more.
  const unclassified: string[] = [];
  const headline: string[] = [];
  for (const pattern of [
    "retry-idempotency",
    "token-refresh",
    "timeout-ladder",
    "optimistic-rollback",
    "pagination-order",
    "reconnect-budget",
  ]) {
    const txt = readFileSync(
      fileURLToPath(new URL(`../patterns/${pattern}/targets.txt`, import.meta.url)),
      "utf8",
    );
    for (const line of txt.split("\n")) {
      const m = /^(\S+)\s+(contract-forbids-\S+)/.exec(line);
      if (!m) continue;
      if (m[1] === "unreachable") unclassified.push(`${pattern}/${m[2]}`);
      if (pattern === "reconnect-budget" && m[2] === "contract-forbids-runaway") {
        headline.push(m[1]!);
      }
    }
  }
  assert(
    "F6 every contract-forbids target records whether a witness was possible",
    unclassified.length === 0,
    unclassified.length === 0
      ? "all rows classified live / by-construction"
      : `still unclassified: ${unclassified.join(", ")}`,
  );
  assert(
    "F6 reconnect-budget's headline property can now fail",
    headline[0] === "unreachable-live",
    `contract-forbids-runaway is recorded as ${headline[0] ?? "(missing)"} ` +
      `(it was a restatement of its own assignment until BUDGETED existed)`,
  );
}

// =====================================================================
// F7 — reconnect-budget: appDeadlineMs bounds one request, the contract is a
//      ladder of them
// =====================================================================
async function F7(): Promise<void> {
  console.log(
    "\n=== F7  reconnect-budget: the solved window covers one attempt, not the budget ===\n" +
      "    settleMs is solved as deadline + tail + margin = one app-bounded round.\n" +
      "    This pattern's contract is MAX_ATTEMPTS of them plus the backoffs, and\n" +
      "    it gets away with 531ms only because every enumerated failure is an\n" +
      "    instantaneous client-side reject. The dropped stream the README names\n" +
      "    ('a reconnect loop', 'the retry also fails') takes the app's own\n" +
      "    500ms deadline to fail, three times over.\n" +
      "    CLOSED: the bridge declares appLadder { attempts: 3, backoffsMs: [60,120] }\n" +
      "    alongside appDeadlineMs and a settleMs that covers it, validated by the\n" +
      "    settle_outlasts_app_ladder constraint. The same hand-written hang plan\n" +
      "    now passes against the correct client it always described.",
  );
  // Hand-written, and still NOT a plan the shipped model can compile to:
  // reconnect.qnt has fulfil/reject actions only, so there is no `hang` rung.
  // That absence is the finding — the rung a model of a dropped stream would
  // obviously add is the one the solved window cannot survive. The app under it
  // is the shipped page in its FIXED variant: a correct, budgeted client.
  const plan: FaultPlan = {
    name: "budget-exhausted-by-timeout",
    schedule: [
      { order: 0, rule: "stream", outcome: "hang", occurrence: 0 },
      { order: 1, rule: "stream", outcome: "hang", occurrence: 1 },
      { order: 2, rule: "stream", outcome: "hang", occurrence: 2 },
    ],
    expect: { ui: "offline", unhandledRejection: false, calls: { stream: 3 } },
    modelSteps: 4,
  } as FaultPlan;
  validatePlan(plan);

  const server = await boot(true); // the shipped page, FIXED — a correct client
  const results = await runPlans([plan], {
    ...reconnectBridge,
    baseUrl: `${server.url}/stream`,
  });
  console.log(verdict(results));
  const r = results[0]!;
  console.log(
    `          observed.ui=${r.observed.ui} matched.stream=${r.observed.matched.stream} ` +
      `pendingAsync=${JSON.stringify(r.observed.pendingAsync)}`,
  );

  // Independent: the same three timeouts, watched for as long as the app's own
  // ladder actually takes.
  const seen = await watchLadder(server.url);
  console.log(
    `\n  INDEPENDENT (raw Playwright, /api/stream never answers, no chaosbringer)\n` +
      `    at 531ms (the solved probe instant): ${JSON.stringify(seen.atProbe)}\n` +
      `    at 2200ms:                          ${JSON.stringify(seen.after)}\n` +
      `    attempts the client actually made: ${seen.attempts}`,
  );
  assert(
    "F7 the correct, budgeted client is no longer reported as an endless spinner",
    fields(results).length === 0 && seen.after.state === "offline" && seen.attempts === 3,
    `oracle said ui="${r.observed.ui}" with ${fields(results).length} mismatch(es) at ` +
      `settleMs=${reconnectBridge.settleMs}; the app reached "${seen.after.state}" after ` +
      `${seen.attempts} attempts (it used to be judged at 531ms, one attempt in)`,
  );
  assert(
    "F7 the window solved for one round is refused, not silently used",
    (() => {
      try {
        resolvePlanTiming({
          settleMs: 531,
          appDeadlineMs: reconnectBridge.appDeadlineMs,
          appLadder: reconnectBridge.appLadder,
          timingProfile: reconnectBridge.timingProfile,
        });
        return false;
      } catch (err) {
        return /settle_outlasts_app_ladder/.test(err instanceof Error ? err.message : "");
      }
    })(),
    "resolvePlanTiming rejects settleMs=531 against a ladder of 3 x 500ms + [60, 120]",
  );
}

async function watchLadder(
  base: string,
): Promise<{ atProbe: { state: string }; after: { state: string }; attempts: number }> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  let attempts = 0;
  await page.route("**/api/stream", async (route) => {
    attempts += 1;
    await new Promise((r) => setTimeout(r, 5000)); // never answers in time
    await route.abort();
  });
  await page.goto(`${base}/stream`);
  const read = () =>
    page.evaluate(() => ({ state: document.getElementById("app")!.dataset.state ?? "" }));
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForTimeout(531);
  const atProbe = await read();
  await page.waitForTimeout(2200 - 531);
  const after = await read();
  await browser.close();
  return { atProbe, after, attempts };
}

// =====================================================================
// F8 — token-refresh: the refresh is not an operation, so no plan can fail it
// =====================================================================
async function F8(): Promise<void> {
  console.log(
    "\n=== F8  token-refresh: the rung the model has no action for ===\n" +
      "    rules WERE { me, prefs }; /api/refresh was not an operation, and\n" +
      "    refreshAndReplay was one atomic action that always succeeded. So no\n" +
      "    plan could make the refresh fail — and a client that retries a failed\n" +
      "    refresh forever satisfied all four committed plans.\n" +
      "    CLOSED: /api/refresh is an operation, refreshAndReplay is split into\n" +
      "    refresh + replay, and `refresh-failed` is a COMMITTED plan — the fifth\n" +
      "    below is loaded from plans/ like every other one, not hand-written.",
  );
  const plans = shippedPlans("token-refresh", [
    "me-fresh__prefs-fresh",
    "me-fresh__prefs-replayed",
    "me-replayed__prefs-fresh",
    "me-replayed__prefs-replayed",
    // The rung. Its schedule 401s the refresh itself, which nothing in the old
    // model could express.
    "refresh-failed",
  ]);

  const runs: Record<string, PlanRunResult[]> = {};
  for (const fixed of [false, true]) {
    const label = fixed ? "fixed" : "buggy";
    const server = await boot(fixed);
    resetLedger();
    runs[label] = await runPlans(plans, {
      ...tokenBridge,
      baseUrl: `${server.url}/audit/token`,
    });
    console.log(`\n  variant=${label} (failed refresh: ${fixed ? "give up" : "retry forever"})`);
    console.log(verdict(runs[label]!));
    const rung = runs[label]!.find((r) => r.plan.name === "refresh-failed")!;
    console.log(
      `          POST /api/refresh seen by the server across the five plans: ` +
        `${callsOn("/api/refresh", "POST").length}; on refresh-failed the fault layers ` +
        `counted ${rung.observed.matched.refresh} and the page reported ui=${rung.observed.ui}`,
    );
  }
  // The four old plans still pass in both variants — they must, or the rung
  // would be flagging refreshes in general. What separates the two apps is the
  // fifth plan, and it separates them by three signals at once.
  expectFields("F8 buggy (five plans)", runs.buggy!, ["amplification", "state", "ui"]);
  // The red team's "fixed" page gives up — and says "Could not load your
  // account", not "you are signed out". Under the rung the model now states,
  // giving up silently is still a violation: one `ui` mismatch, no
  // amplification, no state. That the two apps differ by exactly the retry loop
  // is the closure; that this page is not clean is the rung having content.
  expectFields("F8 fixed (five plans)", runs.fixed!, ["ui"]);
  expectDistinguishable("F8 token-refresh", runs.buggy!, runs.fixed!);
  const rung = (label: string) =>
    runs[label]!.find((r) => r.plan.name === "refresh-failed")!.observed.matched.refresh ?? 0;
  assert(
    "F8 the retry loop is now a number the plan states, not an unreachable branch",
    rung("buggy") > 1 && rung("fixed") === 1,
    `refresh calls on the refresh-failed plan: buggy=${rung("buggy")} fixed=${rung("fixed")} ` +
      `(the plan states exactly 1)`,
  );

  // Independent: the rung itself, driven by hand because no plan can express it.
  const stampede: Record<string, number> = {};
  for (const fixed of [false, true]) {
    const server = await boot(fixed);
    stampede[fixed ? "fixed" : "buggy"] = await refreshStampede(server.url);
  }
  console.log(
    `\n  INDEPENDENT (raw Playwright, /api/me 401s once and /api/refresh 500s)\n` +
      `    POST /api/refresh in a 1500ms window: buggy=${stampede.buggy} fixed=${stampede.fixed}`,
  );
  assert(
    "F8 an unbounded refresh loop is unreachable from any plan and real from the browser",
    stampede.buggy! > 10 && stampede.fixed! === 1,
    `${stampede.buggy} refreshes vs ${stampede.fixed}`,
  );
}

async function refreshStampede(base: string): Promise<number> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  let refreshes = 0;
  await page.route("**/api/refresh", async (route) => {
    refreshes += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  let first = true;
  await page.route("**/api/me", async (route) => {
    if (first) {
      first = false;
      await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
      return;
    }
    await route.continue();
  });
  await page.goto(`${base}/audit/token`);
  await page.getByRole("button", { name: "Load account" }).click();
  await page.waitForTimeout(1500);
  await browser.close();
  return refreshes;
}

// =====================================================================
// W — every pattern's window against its own app-side constants (no browser)
// =====================================================================
async function W(): Promise<void> {
  console.log("\n=== W  observation windows vs the retries and backoffs they have to outlast ===");
  run(new URL("./windows.mts", import.meta.url));
}

function run(url: URL): void {
  const out = execFileSync("npx", ["tsx", fileURLToPath(url)], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  console.log(out.trimEnd());
}

// =====================================================================
// R1 / R2 — hypotheses the patterns refuted
// =====================================================================
async function R1(): Promise<void> {
  console.log(
    "\n=== R1  REFUTATION ATTEMPT: an uncapped retry loop (retry-idempotency) ===\n" +
      "    hypothesis: retry-idempotency lifts no --calls-var, so nothing bounds\n" +
      "    the number of POSTs and a client that keeps trying is invisible",
  );
  const plans = shippedPlans("retry-idempotency", [
    "first-rejectAfter__then-rejectAfter",
    "first-rejectBefore__then-rejectBefore",
  ]);
  const server = await boot(true);
  resetLedger();
  const results = await runPlans(plans, {
    ...retryBridge,
    baseUrl: `${server.url}/audit/retry-uncapped`,
  });
  console.log(verdict(results));
  console.log(`          server ledger: ${callsOn("/api/order", "POST").length} POSTs`);
  const got = fields(results);
  console.log(
    `  REFUTED ${got.length > 0 ? "yes" : "NO — hypothesis stands"}: the plans that predict ` +
      `"error" catch it, because an uncapped client eventually succeeds (fields=${JSON.stringify(got)})`,
  );
  if (got.length === 0) failures.push("R1 was not refuted — the hypothesis holds");
}

async function R2(): Promise<void> {
  console.log(
    "\n=== R2  REFUTATION ATTEMPT: a retry that carries ?attempt=1 (retry-idempotency) ===\n" +
      "    hypothesis: the same $-anchored-rule escape that works on\n" +
      "    reconnect-budget (F2) hides the second write here too",
  );
  const plans = shippedPlans("retry-idempotency", ["first-rejectAfter__then-fulfil"]);
  const server = await boot(true);
  resetLedger();
  const results = await runPlans(plans, {
    ...retryBridge,
    baseUrl: `${server.url}/audit/retry-query`,
  });
  console.log(verdict(results));
  const posts = callsOn("/api/order", "POST");
  console.log(
    `          server ledger: ${posts.length} POSTs (${posts.map((p) => p.path + p.query).join(", ")})`,
  );
  const got = fields(results);
  console.log(
    `  REFUTED ${got.includes("state") ? "yes" : "NO — hypothesis stands"}: the escape works, but ` +
      `expect.state.orders is read from the server rather than from the fault layer, so the ` +
      `uncounted write is still seen (fields=${JSON.stringify(got)})`,
  );
  if (!got.includes("state")) failures.push("R2 was not refuted — the hypothesis holds");
}

// =====================================================================
const ALL: Record<string, () => Promise<void>> = {
  F1, F2, F3, F4, F5, F6, F7, F8, W, R1, R2,
};

try {
  for (const [id, fn] of Object.entries(ALL)) {
    if (want(id)) await fn();
  }
} finally {
  await Promise.all(servers.map((s) => s.close()));
}

console.log(
  failures.length === 0
    ? "\nevery finding reproduced and every refutation held"
    : `\n${failures.length} assertion(s) did not hold:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
