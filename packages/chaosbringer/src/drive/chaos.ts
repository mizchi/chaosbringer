/**
 * `recipeChaos()`: replay a journey with its API failing.
 *
 * `drive` finds a way through a site and writes it as a recipe. This replays
 * that recipe once clean, to learn which of the app's own API endpoints the
 * journey calls (the scan's endpoint rules: `fetch`/`xhr` to its own origin,
 * no static files, no pages), then once per fault with every one of those
 * calls failing: HTTP 500, a network failure, no answer (`scanFaultRule`,
 * the faults the scan's chaos crawls use). Each faulted replay is compared
 * with the clean one.
 *
 * What it reports, per fault that actually fired:
 * - **high**: an uncaught exception or unhandled rejection the clean replay
 *   did not have. The app let the API failure escape.
 * - **medium**: the goal still showed as reached. With every API call
 *   failing, a page that says "done" may be claiming a success that did not
 *   happen, unless the goal needs no API.
 * - **low**: where the journey stopped. Expected when the API is down; it
 *   says which step depends on which call.
 *
 * A fault that never fired is reported as such. Its replay proves nothing.
 */

import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { newIsolatedPage } from "../browser-session.js";
import { fingerprintError } from "../clusters.js";
import { errorMessage } from "../errors.js";
import { applyFaultRules } from "../fault-router.js";
import { runRecipe } from "../recipes/replay.js";
import type { ActionRecipe, RecipeStep } from "../recipes/types.js";
import { SCAN_FAULT_KINDS, SCAN_FAULT_LABELS, type ScanFaultKind } from "../scan/analyze.js";
import { endpointsFromRequests, endpointsPattern, type RequestLike, type ScanEndpoint } from "../scan/endpoints.js";
import { DEFAULT_HANG_RELEASE_MS, scanFaultRule } from "../scan/run.js";
import { DEFAULT_SETTLE_QUIET_MS, pageSettleEnv, settleAdaptive, trackPageRequests } from "../settle.js";
import { type DriveUntil, untilHolds } from "./drive.js";
import { type DriveProblem, siteProblems, watchProblems } from "./problems.js";

export interface RecipeChaosOptions {
  recipe: ActionRecipe;
  /** The goal's success condition, checked after each replay. */
  until?: DriveUntil;
  /** Default: all three (`status`, `abort`, `hang`). */
  faults?: readonly ScanFaultKind[];
  /** Fail these instead of the endpoints the clean replay saw (a regex source). */
  endpointPattern?: string;
  /** Never fail these (`toRegExp` patterns), e.g. a logout endpoint. */
  exclude?: string[];
  /** How long `hang` holds a request before releasing it. Default 8000 ms. */
  hangReleaseMs?: number;
  /** How long to wait for `until` to hold after the replay. Default 5000 ms. */
  goalTimeoutMs?: number;
  /** Timeout of the opening navigation. Default 30 s. */
  navigationTimeoutMs?: number;
  /** Settle cap after the replay. Default 3000 ms. */
  settleCapMs?: number;
  browser?: Browser;
  headless?: boolean;
  contextOptions?: BrowserContextOptions;
  onRun?: (run: RecipeChaosRun) => void;
}

export interface RecipeChaosRun {
  fault: "clean" | ScanFaultKind;
  /** `clean`, `HTTP 500`, `network failure`, `no response`. */
  label: string;
  replay: { ok: boolean; failedAt?: { index: number; step: string; reason: string } };
  /** Whether `until` held after the replay; `null` without one. */
  goalHeld: boolean | null;
  /** Requests the fault answered. 0 means the run proves nothing. */
  fired: number;
  problems: DriveProblem[];
  /** Problems the clean replay did not have (compared by error fingerprint). */
  newProblems: DriveProblem[];
  durationMs: number;
}

export interface RecipeChaosFinding {
  severity: "high" | "medium" | "low";
  fault: ScanFaultKind;
  title: string;
  detail: string[];
}

export interface RecipeChaosResult {
  endpoints: ScanEndpoint[];
  pattern: string | null;
  runs: RecipeChaosRun[];
  findings: RecipeChaosFinding[];
  /** Why no faulted replay ran, when none did. */
  skipped?: string;
}

export async function recipeChaos(opts: RecipeChaosOptions): Promise<RecipeChaosResult> {
  const ownsBrowser = opts.browser === undefined;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  try {
    const clean = await replayOnce(browser, opts, "clean");
    opts.onRun?.(clean.run);
    const start = firstUrl(opts.recipe);
    const endpoints = opts.endpointPattern
      ? []
      : endpointsFromRequests(
          clean.requests.map((r) => ({ ...r, thirdParty: !sameOrigin(r.url, start) })),
          clean.pages,
          { exclude: opts.exclude ?? [] },
        );
    const pattern = opts.endpointPattern ?? endpointsPattern(endpoints);
    const result: RecipeChaosResult = { endpoints, pattern, runs: [clean.run], findings: [] };
    if (!clean.run.replay.ok) {
      result.skipped = `the clean replay failed at step ${clean.run.replay.failedAt?.index}: ${clean.run.replay.failedAt?.reason}`;
      return result;
    }
    if (!pattern) {
      result.skipped = "the journey called none of the app's own API endpoints";
      return result;
    }
    for (const fault of opts.faults ?? SCAN_FAULT_KINDS) {
      const { run } = await replayOnce(browser, opts, fault, pattern, clean.run.problems);
      result.runs.push(run);
      opts.onRun?.(run);
      result.findings.push(...findingsOf(run));
    }
    const order = { high: 0, medium: 1, low: 2 };
    result.findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return result;
  } finally {
    if (ownsBrowser) await browser.close().catch(() => {});
  }
}

async function replayOnce(
  browser: Browser,
  opts: RecipeChaosOptions,
  fault: "clean" | ScanFaultKind,
  pattern?: string,
  cleanProblems: readonly DriveProblem[] = [],
): Promise<{ run: RecipeChaosRun; requests: RequestLike[]; pages: string[] }> {
  const started = Date.now();
  const hangReleaseMs = opts.hangReleaseMs ?? DEFAULT_HANG_RELEASE_MS;
  const { page, close } = await newIsolatedPage(browser, opts.contextOptions);
  try {
    const watch = await watchProblems(page);
    const requests: RequestLike[] = [];
    const pages: string[] = [];
    page.on("request", (r) => {
      // The scan's endpoint rules read CDP's type names.
      const type = r.resourceType() === "fetch" ? "Fetch" : r.resourceType() === "xhr" ? "XHR" : r.resourceType();
      requests.push({ url: r.url(), type });
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pages.push(r.url());
    });
    const session = fault === "clean" || !pattern ? null : await applyFaultRules(page, [scanFaultRule(fault, pattern, hangReleaseMs)]);
    const { tracker, detach } = trackPageRequests(page);

    let replay: RecipeChaosRun["replay"];
    try {
      // Steps only: whether the goal held is `until`'s question, asked after
      // the settle. The recipe's postconditions would wait out their timeout
      // on every faulted run where the goal (rightly) did not show.
      // The opening navigation with a page load's patience: the replayer's
      // step timeout (5 s) is an action's, and a slow site's first load
      // would fail the clean run before anything was tested.
      const [first, ...rest] = opts.recipe.steps;
      let steps = opts.recipe.steps;
      if (first?.kind === "navigate") {
        await page.goto(first.url, { waitUntil: "domcontentloaded", timeout: opts.navigationTimeoutMs ?? 30_000 });
        steps = rest;
      }
      const offset = opts.recipe.steps.length - steps.length;
      const r0 = await runRecipe(page, { ...opts.recipe, steps, postconditions: [] });
      const r = r0.failedAt ? { ...r0, failedAt: { ...r0.failedAt, index: r0.failedAt.index + offset } } : r0;
      replay = r.ok
        ? { ok: true }
        : {
            ok: false,
            failedAt: {
              index: r.failedAt?.index ?? -1,
              step: describeStep(opts.recipe.steps[r.failedAt?.index ?? -1]),
              reason: (r.failedAt?.reason ?? "").split("\n")[0]!,
            },
          };
    } catch (err) {
      replay = { ok: false, failedAt: { index: -1, step: "", reason: errorMessage(err).split("\n")[0]! } };
    }
    watch.setStep(opts.recipe.steps.length);
    // A held request is released after `hangReleaseMs`: wait for that, so
    // what the app does when it finally gives up is part of the run.
    if (session && fault === "hang") await waitUntil(() => session.heldRequests() === 0, hangReleaseMs + 1000, page);
    const cap = opts.settleCapMs ?? 3000;
    await page.waitForLoadState("domcontentloaded", { timeout: cap }).catch(() => {});
    await settleAdaptive(tracker, pageSettleEnv(page, tracker), { quietMs: DEFAULT_SETTLE_QUIET_MS, capMs: cap }).catch(() => {});
    await watch.drain();
    detach();
    // A goal the page shows after a spinner holds a moment after the settle:
    // poll for it, up to `goalTimeoutMs`.
    const goalHeld = opts.until ? await pollUntil(page, opts.until, opts.goalTimeoutMs ?? 5000) : null;
    const fired = session ? (await session.firings()).reduce((n, f) => n + f.fired, 0) : 0;
    await session?.dispose().catch(() => {});
    const seen = new Set(cleanProblems.map(fingerprintOf));
    const run: RecipeChaosRun = {
      fault,
      label: fault === "clean" ? "clean" : SCAN_FAULT_LABELS[fault],
      replay,
      goalHeld,
      fired,
      problems: watch.problems,
      newProblems: fault === "clean" ? [] : siteProblems(watch.problems).filter((p) => !seen.has(fingerprintOf(p))),
      durationMs: Date.now() - started,
    };
    return { run, requests, pages };
  } finally {
    await close();
  }
}

function findingsOf(run: RecipeChaosRun): RecipeChaosFinding[] {
  if (run.fault === "clean") return [];
  const fault = run.fault;
  if (run.fired === 0) {
    return [{ severity: "low", fault, title: `${run.label}: the fault never fired`, detail: ["No API call of the journey was answered by it, so this replay proves nothing."] }];
  }
  const out: RecipeChaosFinding[] = [];
  const escaped = run.newProblems.filter((p) => p.kind === "exception" || p.kind === "unhandled-rejection");
  if (escaped.length > 0) {
    out.push({
      severity: "high",
      fault,
      title: `${run.label}: the app let the API failure escape (${escaped.length} uncaught)`,
      detail: escaped.slice(0, 5).map((p) => `${p.kind}: ${p.message.slice(0, 200)} (at ${p.url})`),
    });
  }
  if (run.goalHeld === true) {
    out.push({
      severity: "medium",
      fault,
      title: `${run.label}: the goal still showed as reached`,
      detail: [`${run.fired} API call(s) failed, yet the success condition held. A success the server never confirmed, unless the goal needs no API.`],
    });
  }
  if (!run.replay.ok && run.replay.failedAt) {
    out.push({
      severity: "low",
      fault,
      title: `${run.label}: the journey stops at step ${run.replay.failedAt.index}`,
      detail: [`${run.replay.failedAt.step}: ${run.replay.failedAt.reason}`],
    });
  }
  return out;
}

function fingerprintOf(p: DriveProblem): string {
  const type = p.kind === "http" ? "network" : p.kind;
  return `${p.kind}:${fingerprintError({ type, message: p.message, url: p.url, timestamp: 0 })}`;
}

function describeStep(s: RecipeStep | undefined): string {
  if (!s) return "";
  switch (s.kind) {
    case "navigate":
      return `navigate ${s.url}`;
    case "click":
    case "waitFor":
      return `${s.kind} ${s.selector}`;
    case "fill":
    case "select":
      return `${s.kind} ${s.selector} = ${JSON.stringify(s.value)}`;
    case "press":
      return `press ${s.key}${s.selector ? ` on ${s.selector}` : ""}`;
    case "click-at":
      return `click at ${s.x},${s.y}`;
    case "wait":
      return `wait ${s.ms}ms`;
  }
}

function firstUrl(recipe: ActionRecipe): string {
  const nav = recipe.steps.find((s) => s.kind === "navigate");
  return nav && nav.kind === "navigate" ? nav.url : "";
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

async function pollUntil(page: Page, until: DriveUntil, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await untilHolds(page, until)) return true;
    if (Date.now() >= deadline || page.isClosed()) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number, page: Page): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond() && Date.now() < until && !page.isClosed()) await new Promise((r) => setTimeout(r, 100));
}
