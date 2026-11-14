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
 *
 * Secrets (`secrets.ts`): what it types into a password or one-time-code
 * field, and the `secrets` a decider types by name (`{{name}}`), are
 * recorded as placeholders and scrubbed from everything it returns, shows
 * the decider or annotates on the video. Their values are only in
 * `secretValues()`. What it cannot scrub: the page's own pixels (a
 * `vision` screenshot, the video's frames of a field the page does not
 * mask) and what the app does with the value (requests it sends, its logs).
 */

import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { readAria, type AriaCandidate } from "../aria-snapshot.js";
import { type BindSpec, type BoundBrowser, bindBrowser, resolveBind } from "../browser-bind.js";
import { newIsolatedPage } from "../browser-session.js";
import { errorMessage } from "../errors.js";
import { toRegExp } from "../fault-router.js";
import { networkConditionsFor } from "../network.js";
import { extractCandidate } from "../recipes/capture.js";
import { type RecipeVars, recipeVariables, UndefinedVariableError } from "../recipes/templating.js";
import type { ActionRecipe, ActionTrace, RecipeStep } from "../recipes/types.js";
import type { NetworkProfile } from "../types.js";
import { DEFAULT_SETTLE_QUIET_MS, pageSettleEnv, settleAdaptive, trackPageRequests } from "../settle.js";
import { type DriveProblem, safeUrl, siteProblems, watchProblems } from "./problems.js";
import { DriveSecrets, secretFieldKind } from "./secrets.js";

export type { DriveProblem } from "./problems.js";

/** One thing the decider can ask for. `index` is into this step's candidates. */
export type DriveDecision =
  | { action: "click"; index: number; reasoning?: string }
  | { action: "fill"; index: number; value: string; submit?: boolean; reasoning?: string }
  | { action: "select"; index: number; value: string; reasoning?: string }
  | { action: "press"; key: string; index?: number; reasoning?: string }
  | {
      action: "done";
      reasoning?: string;
      /**
       * The decider has nothing else to offer (a plan that ran out): when
       * `until` does not hold, the run stops as `stuck` instead of asking
       * again for an answer that cannot change.
       */
      final?: boolean;
    }
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
  /**
   * What was typed, selected or pressed. A secret is its placeholder
   * (`{{password}}`), never its value.
   */
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
  /**
   * Secrets the decider can type by name: a fill of `{{name}}` types the
   * value, which the decider is never shown. The `secrets` option's names,
   * then each field secret drive has kept (`password`, `one_time_code`).
   */
  secrets?: ReadonlyArray<string>;
  /** Lazy viewport capture, for deciders that read pixels. */
  screenshot: () => Promise<Buffer>;
}

/** Picks the next action. `null` (or a throw) is a failed decision. */
export interface DriveDecider {
  readonly name: string;
  decide(input: DriveInput): Promise<DriveDecision | null>;
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
  /**
   * Failed decisions in a row before stopping as `stuck`: answers that led
   * to no action. Only an action that ran resets the count. Default 3;
   * below 1 counts as 1.
   */
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
  /** Timeout of a navigation: the start page's load, and one a step starts (the crawl's `--timeout`). Default 30 s. */
  navigationTimeoutMs?: number;
  /**
   * Settle cap after each action. Default 3000 ms. Even under a higher cap,
   * a page kept busy by long tasks alone, with nothing in flight, stops
   * after max(5 s, ten quiet windows) of that.
   */
  settleCapMs?: number;
  /**
   * Quiet window of the adaptive settle after each step: no request in
   * flight and no long task for this long (the crawl's `--settle <ms>`).
   * Default 100 ms.
   */
  settleQuietMs?: number;
  /** Problems not to record (regex sources, case-insensitive), as the crawl's `ignoreErrorPatterns`. */
  ignoreErrorPatterns?: readonly string[];
  /** Serve requests from this HAR file, as the crawl's `--har-replay`; what it has no entry for goes to the network. */
  harReplay?: string;
  /** Throttle the page with this CDP preset, as the crawl's `--network`. */
  network?: NetworkProfile;
  /** Name for the recipe of a successful run. Default `drive/<host>/<goal slug>`. */
  recipeName?: string;
  /**
   * Values a decider types by name: a fill (or select) of `{{name}}` types
   * `secrets[name]`. The recipe records `{{name}}`, and the value is
   * scrubbed from everything drive returns or shows (see `secrets.ts`). A
   * decision that uses a `{{name}}` this does not define fails its step.
   * Names follow the recipe placeholder grammar (`VARIABLE_NAME_RE`).
   */
  secrets?: Readonly<Record<string, string>>;
  /** After each action. The decision's value and reasoning are scrubbed of secrets, as the entry is. */
  onStep?: (entry: DriveHistoryEntry, decision: DriveDecision) => void;
  /**
   * Serve the browser to other Playwright clients while driving
   * (`browser-bind.ts`): `npx playwright cli attach <title>`, or an MCP
   * client with `npx playwright mcp --endpoint <endpoint>`.
   */
  bind?: BindSpec;
  /** The browser was bound: where to attach. */
  onBind?: (bound: BoundBrowser) => void;
  /**
   * Awaited before the page is closed, after the run: keep the final state
   * open for a bound client to look at or take over. The CLI's `--keep-open`
   * waits for Ctrl-C.
   */
  keepOpen?: (result: DriveResult) => Promise<void>;
}

export type DriveStatus =
  /** `until` held. */
  | "reached"
  /** No `until`: the decider said it was done. Unverified. */
  | "done"
  | "gave-up"
  | "out-of-steps"
  /**
   * The decider failed `maxFailedDecisions` times in a row without an action
   * in between (no answer, a "done" while `until` did not hold, an index
   * that does not exist), or a `final` "done" came while `until` did not hold.
   */
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
  /**
   * The run as a recipe, when it reached its goal (`reached` or `done`). A
   * secret it typed is a placeholder: replay it with `vars: secretValues()`.
   */
  recipe: ActionRecipe | null;
  /** The placeholders `recipe` uses (`["password"]`), `[]` without a recipe. */
  variables: string[];
  /**
   * The value of each secret the run typed or was given, by name: the vars
   * that replay `recipe`. A function, so that `JSON.stringify(result)` (the
   * CLI's drive-report.json) never carries them.
   */
  secretValues: () => RecipeVars;
  /** Why there is no recipe for a successful run. */
  recipeSkipped?: string;
  decider: string;
  /** Set with `bind`. */
  bound?: BoundBrowser;
}

export async function drive(opts: DriveOptions): Promise<DriveResult> {
  const started = Date.now();
  // Whole numbers, and at least one failed decision: with 0 the stuck
  // checks and the cap below would end the run before the first ask.
  const maxSteps = wholeAtLeast(opts.maxSteps, 0, 20);
  const maxFailed = wholeAtLeast(opts.maxFailedDecisions, 1, 3);
  const actionTimeout = opts.actionTimeoutMs ?? 5000;
  const settleCap = opts.settleCapMs ?? 3000;
  const settleQuiet = opts.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS;
  const excluded = (opts.excludePatterns ?? []).map((p) => toRegExp(p)).filter((r): r is RegExp => r !== null);
  const isExcluded = (url: string) => excluded.some((r) => r.test(url));

  const ownsBrowser = opts.browser === undefined;
  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const bindOptions = resolveBind(opts.bind);
  const bound = bindOptions ? await bindBrowser(browser, bindOptions) : undefined;
  if (bound) opts.onBind?.(bound);
  const { context, page, close } = await newIsolatedPage(browser, opts.contextOptions);
  if (opts.harReplay) await context.routeFromHAR(opts.harReplay, { notFound: "fallback" });
  if (opts.navigationTimeoutMs !== undefined) page.setDefaultNavigationTimeout(opts.navigationTimeoutMs);
  if (opts.network) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", networkConditionsFor(opts.network));
  }

  const watch = await watchProblems(page, { ignoreErrorPatterns: opts.ignoreErrorPatterns });
  const problems = watch.problems;
  const drainRejections = () => watch.drain();
  const { tracker, detach } = trackPageRequests(page);
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: settleCap }).catch(() => {});
    await settleAdaptive(tracker, pageSettleEnv(page, tracker), { quietMs: settleQuiet, capMs: settleCap }).catch(() => {});
  };

  if (opts.video) {
    await page.screencast.start({ path: opts.video });
    await page.screencast.showActions({ position: "top-right" });
  }

  const secrets = new DriveSecrets(opts.secrets);
  const history: DriveHistoryEntry[] = [];
  const recipeSteps: (RecipeStep | null)[] = [];
  let status: DriveStatus = "out-of-steps";
  let reason: string | undefined;
  let feedback: string | undefined;
  let failedDecisions = 0;
  // What the failed decisions since the last action were, so a stuck
  // reason names them rather than only the kind of the last one.
  let refused = { done: 0, index: 0, none: 0 };
  const stuckReason = (only: string): string => {
    const kinds = [
      refused.done ? `${refused.done} "done" while the success condition did not hold` : "",
      refused.index ? `${refused.index} ${refused.index === 1 ? "index" : "indices"} not on the page` : "",
      refused.none ? `${refused.none} with no usable answer` : "",
    ].filter(Boolean);
    return kinds.length === 1 ? only : `the decider gave ${failedDecisions} answers in a row that led to no action (${kinds.join(", ")})`;
  };
  let seenProblems = 0;

  const reached = async (): Promise<boolean> => (opts.until ? untilHolds(page, opts.until) : false);
  const finish = async (): Promise<DriveResult> => {
    // Scrubbed again at the end: a value typed into a plain field first and
    // into a password field later was kept as a secret only at that later step.
    const scrub = (text: string) => secrets.scrub(text);
    const result: DriveResult = {
      status,
      ...(reason !== undefined ? { reason: scrub(reason) } : {}),
      steps: history.map((h) => scrubEntry(h, secrets)),
      problems: problems.map((p) => scrubProblem(p, secrets)),
      finalUrl: scrub(safeUrl(page)),
      durationMs: Date.now() - started,
      recipe: null,
      variables: [],
      secretValues: () => secrets.vars(),
      decider: opts.decider.name,
      ...(bound ? { bound } : {}),
    };
    if (status === "reached" || status === "done") {
      const missing = recipeSteps.findIndex((s) => s === null);
      if (history.length === 0) result.recipeSkipped = "the goal held on arrival: there is nothing to replay";
      else if (missing >= 0) result.recipeSkipped = `step ${missing} acted on a control with no role or name to find it by on a later load`;
      else {
        const steps = (recipeSteps as RecipeStep[]).map((st) =>
          st.kind === "fill" || st.kind === "select" ? { ...st, value: secrets.template(st.value) } : st,
        );
        result.recipe = toRecipe(opts, steps, result.finalUrl);
        result.variables = recipeVariables(result.recipe);
      }
    }
    detach();
    if (opts.keepOpen) await opts.keepOpen(result).catch(() => {});
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

  // `step` counts actions, and only an action resets `failedDecisions`, so
  // each action costs at most `maxFailed` asks and a run that acts on
  // nothing is stuck after `maxFailed`: the decider (a paid model) is
  // asked at most `maxSteps × maxFailed` times. The counters keep that
  // bound, so this cap is not reached; it is a backstop should a later
  // branch `continue` without counting.
  const maxDecisions = maxSteps * maxFailed;
  let step = 0;
  for (let asked = 0; step < maxSteps; asked++) {
    if (asked >= maxDecisions) {
      status = "stuck";
      reason = `asked the decider ${asked} times for ${step} action(s) without reaching the goal`;
      break;
    }
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
    // The outline shows a filled field's value (`textbox "Password":
    // hunter2`): the decider gets every text scrubbed of secrets.
    const input: DriveInput = {
      goal: opts.goal,
      url: secrets.scrub(safeUrl(page)),
      title: secrets.scrub(await page.title().catch(() => "")),
      stepIndex: step,
      stepsLeft: maxSteps - step,
      outline: secrets.scrub(view.outline),
      candidates: view.candidates.map(({ index, description, type }) => ({ index, description: secrets.scrub(description), type })),
      // Scrubbed again for each ask, like the result: an entry recorded
      // before its value was known to be a secret (a plain field, then a
      // password field) would show the decider that value.
      history: history.map((h) => scrubEntry(h, secrets)),
      problems: siteProblems(problems.slice(seenProblems)).map((p) => scrubProblem(p, secrets)),
      ...(feedback !== undefined ? { feedback } : {}),
      secrets: secrets.names(),
      screenshot: async () => Buffer.from(await page.screenshot()),
    };
    seenProblems = problems.length;
    feedback = undefined;

    let decision: DriveDecision | null;
    let noAnswer = "the decider gave no usable answer";
    try {
      decision = await opts.decider.decide(input);
    } catch (err) {
      decision = null;
      noAnswer = `decider threw: ${errorMessage(err)}`;
      reason = noAnswer;
    }
    // A failed decision is not an action: it uses no step, and it is
    // counted until an action runs.
    if (!decision) {
      failedDecisions++;
      refused.none++;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        // Not an earlier answer's reasoning: this answer is the one that failed.
        reason = stuckReason(noAnswer);
        break;
      }
      continue;
    }
    if (decision.reasoning) reason = secrets.scrub(decision.reasoning);

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
      if (decision.final) {
        status = "stuck";
        reason = `${decision.reasoning ?? "the decider is done"}, but the success condition does not hold (${describeUntil(opts.until)})`;
        break;
      }
      feedback = `You answered "done", but the goal's success condition does not hold yet (${describeUntil(opts.until)}). Keep going, or answer give_up.`;
      failedDecisions++;
      refused.done++;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        reason = stuckReason("the decider kept answering done while the success condition did not hold");
        break;
      }
      continue;
    }

    const candidate = "index" in decision && decision.index !== undefined ? view.candidates[decision.index] : undefined;
    if ("index" in decision && decision.index !== undefined && !candidate) {
      feedback = `There is no candidate #${decision.index}; pick one of the listed indices.`;
      failedDecisions++;
      refused.index++;
      if (failedDecisions >= maxFailed) {
        status = "stuck";
        reason = stuckReason("the decider kept picking indices that do not exist");
        break;
      }
      continue;
    }

    failedDecisions = 0;
    refused = { done: 0, index: 0, none: 0 };
    watch.setStep(step);
    const before = problems.length;
    // The decision as the history and the recipe keep it: each secret value
    // written as its placeholder. What is typed has them filled in.
    let kept: DriveDecision = "value" in decision ? { ...decision, value: secrets.template(decision.value) } : decision;
    let error: string | undefined;
    try {
      if (candidate?.href && isExcluded(new URL(candidate.href, safeUrl(page)).href)) {
        throw new Error(`refused: ${candidate.href} is excluded`);
      }
      // Read at the moment of the fill, from the element it fills, so a
      // password field's value is a placeholder before anything records it.
      if (kept.action === "fill" && candidate && kept.value !== "" && !secrets.isTemplated(kept.value)) {
        const kind = await secretFieldKind(page.locator(`aria-ref=${candidate.ref}`), actionTimeout);
        if (kind) kept = { ...kept, value: secrets.register(kept.value, kind) };
      }
      const typed: DriveDecision = "value" in kept ? { ...kept, value: resolveSecret(secrets, kept.value) } : kept;
      const secret = "value" in typed && "value" in kept && typed.value !== kept.value;
      // The video's action title is `Fill "<value>"`: not for a secret.
      if (secret && opts.video) await page.screencast.hideActions().catch(() => {});
      try {
        await perform(page, typed, candidate, actionTimeout);
      } finally {
        if (secret && opts.video) await page.screencast.showActions({ position: "top-right" }).catch(() => {});
      }
      await settle();
      if (isExcluded(safeUrl(page))) {
        const landed = safeUrl(page);
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        await settle();
        throw new Error(`landed on excluded ${landed}; went back`);
      }
    } catch (err) {
      error = secrets.scrub(errorMessage(err).split("\n")[0]!);
    }
    await drainRejections();
    const entry: DriveHistoryEntry = {
      step,
      action: kept.action,
      ...(candidate ? { target: secrets.scrub(candidate.description) } : {}),
      ...("value" in kept ? { value: kept.value } : kept.action === "press" ? { value: kept.key } : {}),
      ok: error === undefined,
      ...(error !== undefined ? { error } : {}),
      url: secrets.scrub(safeUrl(page)),
      problems: siteProblems(problems.slice(before)).map((p) => secrets.scrub(`${p.kind}: ${p.message}`)),
    };
    const recorded = recordStep(kept, candidate);
    if (entry.ok) recipeSteps.push(...withExpect(recorded, entry.url, history.at(-1)?.url ?? opts.url));
    history.push(entry);
    opts.onStep?.(entry, { ...kept, ...(kept.reasoning !== undefined ? { reasoning: secrets.scrub(kept.reasoning) } : {}) });
    step++;

    if (await reached()) {
      status = "reached";
      break;
    }
  }
  if (status === "out-of-steps") reason = `used all ${maxSteps} steps without reaching the goal`;
  return finish();
}

/**
 * The text to type for a recorded `value`. A placeholder no secret defines
 * fails the step, naming it, as a replay would.
 */
function resolveSecret(secrets: DriveSecrets, value: string): string {
  try {
    return secrets.resolve(value);
  } catch (err) {
    if (err instanceof UndefinedVariableError) throw new Error(`variable "${err.variable}" is not defined (no secret has that name)`);
    throw err;
  }
}

/** `p` with its text scrubbed: its URL is the page's, which a GET form or a redirect can put a secret in. */
function scrubProblem(p: DriveProblem, secrets: DriveSecrets): DriveProblem {
  return { ...p, message: secrets.scrub(p.message), url: secrets.scrub(p.url) };
}

function scrubEntry(h: DriveHistoryEntry, secrets: DriveSecrets): DriveHistoryEntry {
  return {
    ...h,
    ...(h.target !== undefined ? { target: secrets.scrub(h.target) } : {}),
    ...(h.value !== undefined ? { value: secrets.template(h.value) } : {}),
    ...(h.error !== undefined ? { error: secrets.scrub(h.error) } : {}),
    url: secrets.scrub(h.url),
    problems: h.problems.map((p) => secrets.scrub(p)),
  };
}

/** `value` floored, and at least `min`; `fallback` when it is unset or not a number. */
function wholeAtLeast(value: number | undefined, min: number, fallback: number): number {
  return value === undefined || Number.isNaN(value) ? fallback : Math.max(min, Math.floor(value));
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

export async function untilHolds(page: Page, until: DriveUntil): Promise<boolean> {
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


function safeHref(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
