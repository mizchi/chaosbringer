/**
 * `drive()`: operate a browser towards a goal, with chaosbringer watching.
 *
 * A decider (usually a model, see `deciders.ts`) is shown the page as the
 * accessibility snapshot sees it (`aria-snapshot.ts`): an outline of the
 * page with every operable control numbered, plus what happened so far. It
 * answers with one action — click, fill (with the text it chose), select,
 * press — or says it is done. `drive` performs it, waits for the page to
 * settle, and repeats until the goal holds, the decider gives up, or the
 * step budget runs out.
 *
 * While it drives, the checks a crawl runs keep running: uncaught
 * exceptions, unhandled rejections (`rejections.ts`), console errors,
 * failed requests and 5xx answers are collected per step and shown to the
 * decider as they happen, so a run that "reached the goal" with a broken
 * page on the way says so.
 *
 * What it produces:
 * - a step log and the problems seen, step by step;
 * - with `until`, a verified outcome: the decider's "done" is accepted only
 *   when the condition holds, otherwise it is told so and continues;
 * - a recipe (`recipes/`) of the run when it succeeded, replayable with
 *   `runRecipe` and storable in a `RecipeStore`. Each control is recorded
 *   by a role selector (`role=button[name="Pay"s]`), which finds it again
 *   on a later load where the snapshot's refs do not;
 * - with `video`, a recording (Playwright's `page.screencast`) with every
 *   action annotated on screen and the goal as an opening title.
 */

import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { readAria, type AriaCandidate } from "../aria-snapshot.js";
import { newIsolatedPage } from "../browser-session.js";
import { errorMessage } from "../errors.js";
import { toRegExp } from "../fault-router.js";
import { watchUnhandledRejections } from "../rejections.js";
import { extractCandidate } from "../recipes/capture.js";
import type { ActionRecipe, ActionTrace, RecipeStep } from "../recipes/types.js";
import { DEFAULT_SETTLE_QUIET_MS, pageSettleEnv, settleAdaptive, trackPageRequests } from "../settle.js";

/** One thing the decider can ask for. `index` is into this step's candidates. */
export type DriveDecision =
  | { action: "click"; index: number; reasoning?: string }
  | { action: "fill"; index: number; value: string; submit?: boolean; reasoning?: string }
  | { action: "select"; index: number; value: string; reasoning?: string }
  | { action: "press"; key: string; index?: number; reasoning?: string }
  | { action: "done"; reasoning?: string }
  | { action: "give_up"; reasoning?: string };

export interface DriveCandidateView {
  index: number;
  description: string;
  type: AriaCandidate["type"];
}

export interface DriveHistoryEntry {
  step: number;
  action: DriveDecision["action"];
  /** The control's description. */
  target?: string;
  value?: string;
  ok: boolean;
  error?: string;
  /** Where the page was after the step. */
  url: string;
  /** Problems the step caused, as one line each. */
  problems: string[];
}

export interface DriveInput {
  goal: string;
  url: string;
  title: string;
  stepIndex: number;
  stepsLeft: number;
  /** The accessibility outline, candidates tagged `[#index]`. */
  outline: string;
  candidates: ReadonlyArray<DriveCandidateView>;
  history: ReadonlyArray<DriveHistoryEntry>;
  /** Problems since the previous decision (the initial load's, at step 0). */
  problems: ReadonlyArray<DriveProblem>;
  /** Set when the previous answer was refused: why. */
  feedback?: string;
  /** Lazy viewport capture, for deciders that read pixels. */
  screenshot: () => Promise<Buffer>;
}

/** Picks the next action. `null` (or a throw) is a failed decision. */
export interface DriveDecider {
  readonly name: string;
  decide(input: DriveInput): Promise<DriveDecision | null>;
}

export interface DriveProblem {
  kind: "exception" | "unhandled-rejection" | "console" | "network" | "http";
  message: string;
  url: string;
  /** The step that caused it; -1 for the initial load. */
  step: number;
}

/** When the goal counts as reached. Every given field must hold. */
export interface DriveUntil {
  /** `page.url()` contains this. */
  urlIncludes?: string;
  /** `page.url()` matches this (a `/regex/flags` string or a plain regex source). */
  urlMatches?: string;
  /** The page shows this text. */
  text?: string;
  /** Anything else. */
  check?: (page: Page) => Promise<boolean>;
}

export interface DriveOptions {
  url: string;
  goal: string;
  decider: DriveDecider;
  until?: DriveUntil;
  /** Actions at most. Default 20. */
  maxSteps?: number;
  /** Failed decisions in a row before stopping. Default 3. */
  maxFailedDecisions?: number;
  /**
   * URLs never to reach (`toRegExp` patterns): a link to one is refused, and
   * a step that lands on one is undone with a history back.
   */
  excludePatterns?: string[];
  /** Record a video here, actions annotated. */
  video?: string;
  browser?: Browser;
  headless?: boolean;
  contextOptions?: BrowserContextOptions;
  /** Per-action timeout. Default 5000 ms. */
  actionTimeoutMs?: number;
  /** Settle cap after each action. Default 3000 ms. */
  settleCapMs?: number;
  /** Name for the recipe of a successful run. Default `drive/<host>/<goal slug>`. */
  recipeName?: string;
  onStep?: (entry: DriveHistoryEntry, decision: DriveDecision) => void;
}

export type DriveStatus =
  /** `until` held. */
  | "reached"
  /** No `until`: the decider said it was done. Unverified. */
  | "done"
  | "gave-up"
  | "out-of-steps"
  /** The decider failed `maxFailedDecisions` times in a row. */
  | "stuck"
  /** The start page did not load, or the browser went away. */
  | "error";

export interface DriveResult {
  status: DriveStatus;
  /** The decider's last reasoning, or the error. */
  reason?: string;
  steps: DriveHistoryEntry[];
  problems: DriveProblem[];
  finalUrl: string;
  durationMs: number;
  video?: string;
  /** The run as a recipe, when it reached its goal (`reached` or `done`). */
  recipe: ActionRecipe | null;
  /** Why there is no recipe for a successful run. */
  recipeSkipped?: string;
  decider: string;
}

export async function drive(opts: DriveOptions): Promise<DriveResult> {
  const started = Date.now();
  const maxSteps = opts.maxSteps ?? 20;
  const maxFailed = opts.maxFailedDecisions ?? 3;
  const actionTimeout = opts.actionTimeoutMs ?? 5000;
  const settleCap = opts.settleCapMs ?? 3000;
  const excluded = (opts.excludePatterns ?? []).map((p) => toRegExp(p)).filter((r): r is RegExp => r !== null);
  const isExcluded = (url: string) => excluded.some((r) => r.test(url));

  const ownsBrowser = opts.browser === undefined;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const { page, close } = await newIsolatedPage(browser, opts.contextOptions);

  const problems: DriveProblem[] = [];
  let currentStep = -1;
  const problem = (kind: DriveProblem["kind"], message: string) =>
    problems.push({ kind, message, url: safeUrl(page), step: currentStep });
  page.on("pageerror", (e) => problem("exception", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") problem("console", m.text());
  });
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText ?? "failed";
    // Cancelled in flight: navigating on cancels beacons and prefetches.
    if (failure === "net::ERR_ABORTED") return;
    problem("network", `${r.url()} - ${failure}`);
  });
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 500 || (s >= 400 && r.request().isNavigationRequest() && r.frame() === page.mainFrame())) {
      problem("http", `${r.request().method()} ${r.url()} -> ${s}`);
    }
  });
  const rejections = await watchUnhandledRejections(page);
  const drainRejections = async () => {
    for (const r of await rejections.drain()) problems.push({ kind: "unhandled-rejection", message: r.message, url: r.url ?? safeUrl(page), step: currentStep });
  };
  const { tracker, detach } = trackPageRequests(page);
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: settleCap }).catch(() => {});
    await settleAdaptive(tracker, pageSettleEnv(page, tracker), { quietMs: DEFAULT_SETTLE_QUIET_MS, capMs: settleCap }).catch(() => {});
  };

  if (opts.video) {
    await page.screencast.start({ path: opts.video });
    await page.screencast.showActions({ position: "top-right" });
  }

  const history: DriveHistoryEntry[] = [];
  const recipeSteps: (RecipeStep | null)[] = [];
  let status: DriveStatus = "out-of-steps";
  let reason: string | undefined;
  let feedback: string | undefined;
  let failedDecisions = 0;
  let seenProblems = 0;

  const reached = async (): Promise<boolean> => (opts.until ? untilHolds(page, opts.until) : false);
  const finish = async (): Promise<DriveResult> => {
    const result: DriveResult = {
      status,
      ...(reason !== undefined ? { reason } : {}),
      steps: history,
      problems,
      finalUrl: safeUrl(page),
      durationMs: Date.now() - started,
      recipe: null,
      decider: opts.decider.name,
    };
    if (status === "reached" || status === "done") {
      const missing = recipeSteps.findIndex((s) => s === null);
      if (history.length === 0) result.recipeSkipped = "the goal held on arrival: there is nothing to replay";
      else if (missing >= 0) result.recipeSkipped = `step ${missing} acted on a control with no role or name to find it by on a later load`;
      else result.recipe = toRecipe(opts, recipeSteps as RecipeStep[], result.finalUrl);
    }
    detach();
    if (opts.video) {
      await page.screencast.stop().catch(() => {});
      result.video = opts.video;
    }
    await close();
    if (ownsBrowser) await browser.close().catch(() => {});
    return result;
  };

  try {
    // A 4xx/5xx start page is recorded by the response listener, and the
    // run goes on: a 404 page can still have the search box the goal needs.
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    if (opts.video) await page.screencast.showChapter(opts.goal, { description: opts.url, duration: 1500 }).catch(() => {});
    await settle();
  } catch (err) {
    status = "error";
    reason = `could not load ${opts.url}: ${errorMessage(err)}`;
    return finish();
  }
  await drainRejections();

  if (await reached()) {
    status = "reached";
    return finish();
  }

  for (let step = 0; step < maxSteps; step++) {
    if (page.isClosed()) {
      status = "error";
      reason = "the page closed";
      break;
    }
    // A click that navigated can leave the new document still parsing when
    // the settle returns (it waited on the old one): an empty snapshot.
    await page.waitForLoadState("domcontentloaded", { timeout: settleCap }).catch(() => {});
    const view = await readAria(page).catch((err: unknown) => {
      reason = `could not read the page: ${errorMessage(err)}`;
      return null;
    });
    if (!view) {
      status = "error";
      break;
    }
    const input: DriveInput = {
      goal: opts.goal,
      url: safeUrl(page),
      title: await page.title().catch(() => ""),
      stepIndex: step,
      stepsLeft: maxSteps - step,
      outline: view.outline,
      candidates: view.candidates.map(({ index, description, type }) => ({ index, description, type })),
      history,
      problems: problems.slice(seenProblems),
      ...(feedback !== undefined ? { feedback } : {}),
      screenshot: async () => Buffer.from(await page.screenshot()),
    };
    seenProblems = problems.length;
    feedback = undefined;

    let decision: DriveDecision | null;
    try {
      decision = await opts.decider.decide(input);
    } catch (err) {
      decision = null;
      reason = `decider threw: ${errorMessage(err)}`;
    }
    if (!decision) {
      failedDecisions++;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        reason ??= "the decider gave no usable answer";
        break;
      }
      step--; // a failed decision is not an action
      continue;
    }
    failedDecisions = 0;
    if (decision.reasoning) reason = decision.reasoning;

    if (decision.action === "give_up") {
      status = "gave-up";
      break;
    }
    if (decision.action === "done") {
      if (!opts.until) {
        status = "done";
        break;
      }
      if (await reached()) {
        status = "reached";
        break;
      }
      feedback = `You answered "done", but the goal's success condition does not hold yet (${describeUntil(opts.until)}). Keep going, or answer give_up.`;
      step--;
      failedDecisions++;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        reason = "the decider kept answering done while the success condition did not hold";
        break;
      }
      continue;
    }

    const candidate = "index" in decision && decision.index !== undefined ? view.candidates[decision.index] : undefined;
    if ("index" in decision && decision.index !== undefined && !candidate) {
      feedback = `There is no candidate #${decision.index}; pick one of the listed indices.`;
      failedDecisions++;
      step--;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        reason = "the decider kept picking indices that do not exist";
        break;
      }
      continue;
    }

    currentStep = step;
    const before = problems.length;
    const entry: DriveHistoryEntry = {
      step,
      action: decision.action,
      ...(candidate ? { target: candidate.description } : {}),
      ...("value" in decision ? { value: decision.value } : decision.action === "press" ? { value: decision.key } : {}),
      ok: true,
      url: "",
      problems: [],
    };
    const recorded = recordStep(decision, candidate);
    try {
      if (candidate?.href && isExcluded(new URL(candidate.href, safeUrl(page)).href)) {
        throw new Error(`refused: ${candidate.href} is excluded`);
      }
      await perform(page, decision, candidate, actionTimeout);
      await settle();
      if (isExcluded(safeUrl(page))) {
        const landed = safeUrl(page);
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle();
        throw new Error(`landed on excluded ${landed}; went back`);
      }
    } catch (err) {
      entry.ok = false;
      entry.error = errorMessage(err).split("\n")[0];
    }
    await drainRejections();
    entry.url = safeUrl(page);
    entry.problems = problems.slice(before).map((p) => `${p.kind}: ${p.message}`);
    if (entry.ok) recipeSteps.push(...withExpect(recorded, entry.url, history.at(-1)?.url ?? opts.url));
    history.push(entry);
    opts.onStep?.(entry, decision);

    if (await reached()) {
      status = "reached";
      break;
    }
  }
  if (status === "out-of-steps") reason = `used all ${maxSteps} steps without reaching the goal`;
  return finish();
}

async function perform(page: Page, d: DriveDecision, c: AriaCandidate | undefined, timeout: number): Promise<void> {
  const target = c ? page.locator(`aria-ref=${c.ref}`) : undefined;
  switch (d.action) {
    case "click":
      await target!.click({ timeout });
      return;
    case "fill":
      await target!.fill(d.value, { timeout });
      if (d.submit) await target!.press("Enter", { timeout });
      return;
    case "select":
      await target!.selectOption(d.value, { timeout });
      return;
    case "press":
      if (target) await target.press(d.key, { timeout });
      else await page.keyboard.press(d.key);
      return;
    default:
      return;
  }
}

/** The recipe steps one action records, `[null]` when its control has no stable selector. */
function recordStep(d: DriveDecision, c: AriaCandidate | undefined): (RecipeStep | null)[] {
  if (d.action === "press" && !c) return [{ kind: "press", key: d.key }];
  const selector = c?.selector;
  if (!selector) return [null];
  switch (d.action) {
    case "click":
      return [{ kind: "click", selector }];
    case "fill":
      return d.submit
        ? [{ kind: "fill", selector, value: d.value }, { kind: "press", key: "Enter", selector }]
        : [{ kind: "fill", selector, value: d.value }];
    case "select":
      return [{ kind: "select", selector, value: d.value }];
    case "press":
      return [{ kind: "press", key: d.key, selector }];
    default:
      return [];
  }
}

/** A step that moved the page to another path waits, on replay, until it has. */
function withExpect(steps: (RecipeStep | null)[], after: string, before: string): (RecipeStep | null)[] {
  const path = (u: string) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  };
  if (steps.length === 0 || path(after) === path(before)) return steps;
  const last = steps[steps.length - 1];
  if (!last || last.kind === "wait" || last.kind === "waitFor" || last.kind === "click-at") return steps;
  return [...steps.slice(0, -1), { ...last, expectAfter: { urlContains: path(after) } }];
}

function toRecipe(opts: DriveOptions, steps: RecipeStep[], finalUrl: string): ActionRecipe {
  const start = safeHref(opts.url);
  const trace: ActionTrace = {
    goal: opts.goal,
    steps: [{ kind: "navigate", url: start }, ...steps],
    startState: { url: start },
    endState: { url: finalUrl },
    durationMs: 0,
    successful: true,
  };
  const postconditions = opts.until?.text ? [{ hasSelector: `text=${JSON.stringify(opts.until.text)}` }] : [];
  return extractCandidate(trace, {
    name: opts.recipeName ?? defaultRecipeName(opts.url, opts.goal),
    description: opts.goal,
    origin: "ai-extracted",
    inferUrlPreconditions: false,
    extraPostconditions: postconditions,
  });
}

export function defaultRecipeName(url: string, goal: string): string {
  let host = "site";
  try {
    host = new URL(url).host;
  } catch {}
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `drive/${host}/${slug || "goal"}`;
}

async function untilHolds(page: Page, until: DriveUntil): Promise<boolean> {
  const url = safeUrl(page);
  if (until.urlIncludes !== undefined && !url.includes(until.urlIncludes)) return false;
  if (until.urlMatches !== undefined) {
    const re = toRegExp(until.urlMatches);
    if (!re || !re.test(url)) return false;
  }
  if (until.text !== undefined) {
    const visible = await page.getByText(until.text).first().isVisible().catch(() => false);
    if (!visible) return false;
  }
  if (until.check && !(await until.check(page).catch(() => false))) return false;
  return true;
}

function describeUntil(until: DriveUntil): string {
  const parts: string[] = [];
  if (until.urlIncludes !== undefined) parts.push(`the URL contains ${JSON.stringify(until.urlIncludes)}`);
  if (until.urlMatches !== undefined) parts.push(`the URL matches ${until.urlMatches}`);
  if (until.text !== undefined) parts.push(`the page shows ${JSON.stringify(until.text)}`);
  if (until.check) parts.push("a custom check passes");
  return parts.join(" and ");
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function safeHref(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
