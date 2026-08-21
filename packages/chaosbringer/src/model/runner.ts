/**
 * Replay a `FaultPlan` in a real browser and check the model's oracle.
 *
 * One plan = one `chaos()` run = one user action, with every operation's
 * outcome pinned by an occurrence-indexed fault schedule. No probabilities
 * are involved, so a plan either reproduces or reports why it could not:
 *
 *   - the UI ended somewhere the model didn't predict        → `ui` mismatch
 *   - …or ended there and then moved on                      → `ui@late`
 *   - the page violated an invariant its own label promises  → `uiInvariant`
 *   - …or violated it only after the probe                   → `uiInvariant@late`
 *   - a rejection escaped (or failed to escape) every handler → `unhandledRejection`
 *   - …and did so only after the probe                       → `unhandledRejection@late`
 *   - an observable the model named came out wrong            → `state`
 *   - the app never issued a request the plan was waiting for → `injection`
 *   - the app issued requests the model never described       → `amplification`
 *
 * The `injection` one matters most: without it a plan whose operation is
 * never called looks like a pass, and the coverage claim becomes a lie.
 *
 * Two of these exist because **a probe is an instant and a bug is not**. A
 * retry scheduled on the error path, or a backend that acknowledges a write
 * now and commits it later, lands after the settle window — so the run keeps
 * watching for a derived `quiescenceMs`, drains the timers the app itself
 * scheduled, and reads the state observables a second time. What that window
 * cannot cover is stated in the recipe rather than papered over.
 */

import type { Page } from "playwright";
import { chaos } from "../chaos.js";
import {
  checkTiming,
  formatTimingCheck,
  ladderSettleMs,
  solveTiming,
  DEFAULT_TIMING_PROFILE,
  type AppLadder,
  type TimingProfile,
  type TimingSolution,
} from "../timing.js";
import type { CrawlReport, FaultRule, Invariant, RuntimeFault, UrlMatcher } from "../types.js";
import type { FaultPlan, PlanOutcome, PlanStep } from "./plan.js";
import { validatePlan } from "./plan.js";

/** Which layer realises an outcome. Mixing layers on one rule desyncs occurrence counters. */
type OutcomeLayer = "runtime" | "network" | "none";

const OUTCOME_LAYER: Readonly<Record<PlanOutcome, OutcomeLayer>> = {
  pass: "none",
  reject: "runtime",
  abort: "runtime",
  "reject-body": "runtime",
  hang: "runtime",
  status: "network",
  // A delay has to happen on the wire: a client-side patch cannot make a
  // request take longer without also taking over its response.
  "slow-ok": "network",
  "slow-trip": "network",
};

/**
 * Where a model operation lives, in HTTP terms.
 *
 * A bare matcher is the common case. Use the object form when one URL carries
 * more than one operation — `GET /api/todos` and `POST /api/todos` are
 * different operations that a URL pattern alone cannot tell apart, and
 * without the method filter a plan would fire on whichever call came first.
 */
export type PlanRuleTarget = UrlMatcher | { urlPattern: UrlMatcher; methods?: string[] };

/**
 * A DOM invariant tied to a `ui` label. Returns a message describing the
 * violation, or anything falsy when the page is consistent.
 */
export type UiInvariant = (
  page: Page,
) => Promise<string | null | undefined | void> | string | null | undefined | void;

export interface RunPlanOptions {
  /** Page to open. The modelled action runs on this page after load. */
  baseUrl: string;
  /** Model operation id → where it lives. Every rule a plan references must be here. */
  rules: Record<string, PlanRuleTarget>;
  /**
   * Fire the modelled user action (click "Load", submit the form, …). Omit
   * for models whose operations are issued by page load itself.
   */
  action?: (page: Page) => Promise<void>;
  /** Map the page back to the model's UI vocabulary. Omit to skip `ui` checks. */
  uiProbe?: (page: Page) => Promise<string>;
  /**
   * Read the observables a plan's `expect.state` names — server-side counters,
   * storage, anything. Most real failures (a retry that writes twice, a
   * refresh stampede) are invisible on screen, so this is how a model asserts
   * on them. Only the keys a plan actually expects are compared.
   */
  stateProbe?: (page: Page) => Promise<Record<string, unknown>>;
  /**
   * Quiet period after the action before probing. Default 500ms.
   *
   * When `appDeadlineMs` is set this is *validated* rather than trusted: a
   * settle window shorter than the app's own deadline reports a correctly
   * bounded request as stuck, which is a harness bug wearing an app bug's
   * clothes.
   *
   * Declaring both is allowed and is how an author who knows their app
   * retries states the window while still getting solved `slow-ok` /
   * `slow-trip` delays — those are then re-derived from the *declared*
   * window, since a tripping delay that lands before the probe reads as
   * healthy however the probe instant was chosen.
   */
  settleMs?: number;
  /**
   * The app's own request bound (`AbortSignal.timeout(n)`, a `Promise.race`
   * deadline, …). Set it and the timing values are solved from
   * `timingProfile` instead of guessed — required for plans using the
   * `slow-ok` / `slow-trip` outcomes, since those have no fixed millisecond
   * value.
   */
  appDeadlineMs?: number;
  /**
   * The app's own retry ladder, when it has one: `{ attempts, backoffsMs }`.
   *
   * `appDeadlineMs` describes *one* request, and the window solved from it
   * covers one round. A client that retries three times before it gives up
   * reaches its terminal state three rounds and two backoffs later, so that
   * window reports a correctly budgeted client as an endless spinner. Declare
   * the ladder together with a `settleMs` that covers it and the pre-flight
   * checks the pair (`settle_outlasts_app_ladder`) instead of letting the run
   * find out.
   *
   * Declared, not derived: only the bridge author knows how many rungs their
   * client climbs. Requires `appDeadlineMs` and `settleMs` — the error names
   * the smallest window that works.
   */
  appLadder?: AppLadder;
  /**
   * Measured environment profile from `chaosbringer model calibrate`.
   * Defaults to `DEFAULT_TIMING_PROFILE`, which is pessimistic on purpose.
   */
  timingProfile?: TimingProfile;
  /** Page timeout, forwarded to the crawler. Default 15000ms. */
  timeout?: number;
  /**
   * Per-`ui`-label DOM invariants: what the page must *also* be true of when
   * it reports that label.
   *
   * `expect.ui` is one word lifted from a model variable, and a word is easy
   * to get right on a page that is wrong — an error banner over a summary
   * rendered from the previous, now-unverifiable quote, with the Pay button
   * still enabled, reports `error` exactly as the model predicted. Keyed by
   * label, plus `"*"` for invariants that hold in every state. Return a
   * message to fail, anything falsy to pass.
   *
   * Checked at the same instant `uiProbe` runs, which is the moment the
   * oracle judges the page.
   */
  uiInvariants?: Record<string, UiInvariant>;
  /**
   * Extra observation window after the probe, in ms.
   *
   * Only spent when a plan names state observables (`expect.state`), because
   * that is the only check a second read can change: the settled value is
   * what the model predicted, and a probe that reads a count before the
   * backend has committed the duplicate write reports the number the model
   * wanted to see. Solved from `appDeadlineMs` + `timingProfile` when those
   * are given (one more app-bounded round), else defaults to `settleMs` —
   * the same "one more round" unit the bridge author already chose. `0`
   * disables it.
   */
  quiescenceMs?: number;
  /**
   * Cap on waiting for timers the app scheduled itself, in ms. Default 3000.
   *
   * The run instruments `setTimeout` before firing the action, so it knows
   * whether the page has work due in the future and how far out. Waiting for
   * it is what makes `unhandledRejection: false` a fact rather than a
   * coincidence of when the probe fired: a `void retry()` inside a 900ms
   * backoff escapes every handler, and a run that ends at 400ms never sees
   * it. Costs nothing on a page with no pending timers. `0` disables both
   * the instrumentation and the wait.
   */
  asyncDrainCapMs?: number;
  /**
   * Compare observed call counts against the plan's occurrence span, and
   * report a rule the app called more often than the model described.
   * Default false.
   *
   * Off by default because it is only sound against a model that accounts
   * for *every* call on that URL, page-load fetches included. A model
   * written for one user action will legitimately see more requests than its
   * schedule mentions, and reporting that would be a false positive. A plan
   * that does know the totals says so with `expect.calls`, which is always
   * checked.
   */
  checkAmplification?: boolean;
  /** Default true. */
  headless?: boolean;
  /** Seed, forwarded to the crawler. Default 1 (plans don't use the RNG). */
  seed?: number;
  /** HTTP status used for `status` outcomes. Default 500. */
  statusCode?: number;
  /** Run plans flagged `orderSensitive` anyway. Default false. */
  allowOrderSensitive?: boolean;
  /**
   * Collect a V8 coverage fingerprint per plan, so `aggregateCoverage` can
   * report plans the model calls distinct states but whose executed code was
   * identical. Costs a CDP profiler session per run.
   */
  coverageFingerprints?: boolean;
}

export type MismatchField =
  | "ui"
  /**
   * The label was right at the probe and wrong afterwards — see
   * `quiescenceMs`. A `Promise.race` "timeout" renders `error` on schedule and
   * then renders the response it claimed to have given up on.
   */
  | "ui@late"
  | "uiInvariant"
  /** An invariant that held at the probe and stopped holding during the window. */
  | "uiInvariant@late"
  | "unhandledRejection"
  /** A rejection that escaped only after the probe — see `quiescenceMs`. */
  | "unhandledRejection@late"
  | "injection"
  /** More calls on an operation than the model described. */
  | "amplification"
  | "state";

export interface PlanMismatch {
  plan: string;
  field: MismatchField;
  expected: unknown;
  actual: unknown;
  /** Human-readable one-liner for reports. */
  detail: string;
}

export interface PlanRunResult {
  plan: FaultPlan;
  /** Set when the plan was not executed. */
  skipped?: "order-sensitive";
  observed: {
    ui?: string;
    /**
     * The same `uiProbe` re-read after the observation window. Present only
     * when the plan named a `ui` label (or the bridge declared invariants) and
     * `quiescenceMs > 0`.
     *
     * Deliberately *not* authoritative, unlike `stateSettled`: a label that
     * started wrong and converged is a page catching up, and the settled read
     * is what a state count needs because the count is cumulative. A label is
     * not — the user sees both — so what is reported is the *move away* from a
     * prediction the page had already met.
     */
    uiSettled?: string;
    unhandledRejection: boolean;
    /**
     * A rejection escaped only *after* the probe, during the observation
     * window. Kept separate from `unhandledRejection` because the two mean
     * different things to a reader: one is a page that was already broken
     * when the oracle looked, the other is work the app scheduled and never
     * guarded.
     */
    lateUnhandledRejection: boolean;
    /** Faults that fired, keyed by `${rule}:${outcome}`. */
    fired: Record<string, number>;
    /**
     * Requests seen per *model operation* — the `matched` count both fault
     * layers already keep, no longer discarded. `matched=12 injected=1` and
     * `matched=1 injected=1` are the same verdict without it.
     */
    matched: Record<string, number>;
    /** Whatever `stateProbe` returned at the probe. */
    state?: Record<string, unknown>;
    /**
     * The same probe re-read after the observation window. Present only when
     * the plan named state observables and `quiescenceMs > 0`. This is the
     * read `expect.state` is compared against: the settled value, not the
     * one that happened to be true at `settleMs`.
     */
    stateSettled?: Record<string, unknown>;
    /**
     * Work the page still had scheduled when the run ended. Reported, never
     * failed on: a session-expiry timer 30 minutes out is not a bug, and an
     * uncleared interval is a fact about the app rather than a verdict.
     */
    pendingAsync?: { timers: number; intervals: number; latestDueInMs?: number };
    /** Thrown by `action` / `uiProbe` / `stateProbe`, if any did. */
    probeError?: string;
    /** V8 coverage digest, when `coverageFingerprints` was set. */
    coverageFingerprint?: string;
  };
  mismatches: PlanMismatch[];
  /** The underlying crawl report — artifacts, errors, timings. */
  report?: CrawlReport;
}

/** Stable fault name so post-run stats can be attributed back to a step. */
export function faultNameFor(rule: string, outcome: PlanOutcome): string {
  return `${rule}:${outcome}`;
}

/** Name of the counting-only rule that observes an operation nothing injects. */
export function observationNameFor(rule: string): string {
  return `${rule}:observe`;
}

/**
 * Build the fault list for one plan.
 *
 * One fault per (rule, outcome) pair, carrying a decision table over that
 * rule's occurrences: `inject` where this outcome applies, `pass` elsewhere.
 * Every fault watching a rule therefore sees the same occurrence numbering
 * (the fault layers advance scheduled counters on every match, even when
 * another fault claims the call).
 */
export function compilePlanFaults(
  plan: FaultPlan,
  rules: Record<string, PlanRuleTarget>,
  statusCode = 500,
  /**
   * Millisecond values for the timing outcomes, from `resolvePlanTiming`.
   * Absent means a plan using them is a configuration error rather than a
   * guess: `slow-ok` has no portable default.
   */
  delays?: { fastMs: number; slowMs: number },
): {
  runtimeFaults: RuntimeFault[];
  faultInjection: FaultRule[];
  expectedInjections: Map<string, number>;
  /**
   * Model operation → how many calls the plan says happen, for rules where
   * *nothing* is injected. Only populated for a schedule that is entirely
   * `pass`: there, no injected outcome can have prevented a later request, so
   * "the app never called it" is a finding rather than the model's own
   * prediction playing out. Backed by a counting rule below.
   */
  expectedObservations: Map<string, number>;
  /** Fault name → model operation, so per-rule `matched` can be attributed. */
  ruleOfFault: Map<string, string>;
} {
  const byRule = new Map<string, PlanStep[]>();
  for (const step of plan.schedule) {
    const bucket = byRule.get(step.rule);
    if (bucket) bucket.push(step);
    else byRule.set(step.rule, [step]);
  }

  const runtimeFaults: RuntimeFault[] = [];
  const faultInjection: FaultRule[] = [];
  const expectedInjections = new Map<string, number>();
  const expectedObservations = new Map<string, number>();
  const ruleOfFault = new Map<string, string>();
  // A plan whose every step is `pass` injects nothing, so the injection
  // check — the one guard against "the app never made this call" — has
  // nothing to check. That is every model's happy path, and a page serving a
  // stale cache without revalidating satisfies it by doing nothing at all.
  const allPass = plan.schedule.length > 0 && plan.schedule.every((s) => s.outcome === "pass");

  for (const [rule, steps] of byRule) {
    const target = rules[rule];
    if (target === undefined) {
      throw new Error(
        `chaosbringer/model: plan "${plan.name}" references operation "${rule}" with no entry in \`rules\``,
      );
    }
    const isTargetObject =
      typeof target === "object" && target !== null && !(target instanceof RegExp);
    const urlPattern = isTargetObject ? target.urlPattern : target;
    const methods = isTargetObject ? target.methods : undefined;
    const methodFilter = methods !== undefined ? { methods } : {};

    const layers = new Set(steps.map((s) => OUTCOME_LAYER[s.outcome]).filter((l) => l !== "none"));
    if (layers.size > 1) {
      throw new Error(
        `chaosbringer/model: plan "${plan.name}" mixes network- and runtime-layer outcomes on operation "${rule}". ` +
          `A client-side rejection issues no request, so the two layers would number occurrences differently — ` +
          `split the operation into two rules instead.`,
      );
    }

    // Length of the decision table = highest occurrence this rule uses + 1.
    const span = Math.max(...steps.map((s) => s.occurrence)) + 1;
    const byOutcome = new Map<PlanOutcome, PlanStep[]>();
    for (const step of steps) {
      if (step.outcome === "pass") continue; // nothing to inject
      const bucket = byOutcome.get(step.outcome);
      if (bucket) bucket.push(step);
      else byOutcome.set(step.outcome, [step]);
    }

    for (const [outcome, outcomeSteps] of byOutcome) {
      const decisions: Array<"pass" | "inject"> = Array.from({ length: span }, () => "pass");
      for (const step of outcomeSteps) decisions[step.occurrence] = "inject";
      const name = faultNameFor(rule, outcome);
      expectedInjections.set(name, outcomeSteps.length);
      ruleOfFault.set(name, rule);
      const schedule = { decisions, afterEnd: "pass" as const };

      switch (outcome) {
        case "reject":
          runtimeFaults.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            action: { kind: "reject-fetch", rejectAs: "TypeError", rejectionMessage: `model:${name}` },
          });
          break;
        case "abort":
          runtimeFaults.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            action: { kind: "reject-fetch", rejectAs: "AbortError", rejectionMessage: `model:${name}` },
          });
          break;
        case "reject-body":
          runtimeFaults.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            action: { kind: "reject-body", rejectionMessage: `model:${name}` },
          });
          break;
        case "hang":
          // Client-side: no request is issued, so page load isn't blocked
          // waiting for networkidle. The app simply never gets its answer.
          runtimeFaults.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            action: { kind: "never-settle-fetch" },
          });
          break;
        case "status":
          faultInjection.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            fault: { kind: "status", status: statusCode },
          });
          break;
        case "slow-ok":
        case "slow-trip": {
          if (!delays) {
            throw new Error(
              `chaosbringer/model: plan "${plan.name}" uses the "${outcome}" outcome, which has no ` +
                `portable millisecond value — set \`appDeadlineMs\` (and ideally a \`timingProfile\` ` +
                `from \`chaosbringer model calibrate\`) so the delay can be solved for this machine.`,
            );
          }
          faultInjection.push({
            name,
            urlPattern,
            ...methodFilter,
            schedule,
            fault: { kind: "delay", ms: outcome === "slow-ok" ? delays.fastMs : delays.slowMs },
          });
          break;
        }
        case "pass":
          break;
      }
    }

    // A rule that injects nothing still needs its requests counted. Without a
    // route there is no `matched` for it, so an `expect.calls` bound naming it
    // would be accepted, typechecked, and then never enforced — the exact
    // failure mode this pipeline exists to remove. Counting is behaviourally
    // neutral: every decision is `pass`, so `route.fallback()` runs for it
    // exactly as if the rule were absent. And unlike a counter installed after
    // page load, this one sees the fetch a page issues on mount, which is
    // occurrence 0 of most read operations.
    //
    // *Requiring* those calls is a separate question with a different answer,
    // which is why only the plan-level `allPass` case sets an expectation: in a
    // plan that injects something, an injected failure can legitimately stop
    // the app from issuing a later request (`await a; await b` never reaches
    // `b`), so demanding the call would flag the model's own prediction as a
    // bug. Count always, require only when nothing was injected.
    if (byOutcome.size === 0) {
      const name = observationNameFor(rule);
      ruleOfFault.set(name, rule);
      if (allPass) expectedObservations.set(rule, steps.length);
      faultInjection.push({
        name,
        urlPattern,
        ...methodFilter,
        schedule: { decisions: Array.from({ length: span }, () => "pass" as const), afterEnd: "pass" },
        // Never reached: every decision is `pass`. Present because a
        // `FaultRule` must name a fault.
        fault: { kind: "status", status: 599 },
      });
    }
  }

  // An `expect.calls` entry on an operation the schedule never pins is the
  // model saying "and this endpoint is called exactly n times", most usefully
  // with n = 0: token-refresh's both-tokens-fresh control claims the refresh
  // endpoint is never touched at all. Without a route nothing counts it, so
  // the oracle would skip the comparison and the claim would be decoration —
  // so give it the same counting-only rule a pass-only operation gets. The
  // count is required (it is an equality against the model's own number); the
  // *call* is not, because nothing was injected to require it of.
  for (const rule of Object.keys(plan.expect.calls ?? {})) {
    if (byRule.has(rule)) continue;
    const target = rules[rule];
    if (target === undefined) {
      throw new Error(
        `chaosbringer/model: plan "${plan.name}" expects calls on operation "${rule}" with no entry in \`rules\``,
      );
    }
    const isTargetObject =
      typeof target === "object" && target !== null && !(target instanceof RegExp);
    const name = observationNameFor(rule);
    ruleOfFault.set(name, rule);
    faultInjection.push({
      name,
      urlPattern: isTargetObject ? target.urlPattern : target,
      ...(isTargetObject && target.methods !== undefined ? { methods: target.methods } : {}),
      // No occurrence is pinned, so there is nothing to decide — one `pass`
      // and `afterEnd: "pass"` is every request falling through and being
      // counted on the way past. (A table has to have at least one row.)
      schedule: { decisions: ["pass"], afterEnd: "pass" },
      fault: { kind: "status", status: 599 },
    });
  }

  return { runtimeFaults, faultInjection, expectedInjections, expectedObservations, ruleOfFault };
}

/**
 * Is this matcher a regex anchored at the end of the URL string?
 *
 * `/\/api\/stream$/` is one; `/\/api\/stream(\?|$)/` is not, and neither is a
 * literal `\$`. A trailing `$` is only an anchor when an even number of
 * backslashes precedes it.
 */
function isEndAnchored(matcher: UrlMatcher): boolean {
  if (!(matcher instanceof RegExp)) return false;
  const src = matcher.source;
  if (!src.endsWith("$")) return false;
  let backslashes = 0;
  for (let i = src.length - 2; i >= 0 && src[i] === "\\"; i--) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Refuse a `$`-anchored `urlPattern` on an operation whose plan states
 * `expect.calls`.
 *
 * Everywhere else a rule's regex is a *selector*: too narrow and you inject
 * less than you meant, which shows up as a missing injection. Under
 * `expect.calls` it is the definition of the number being asserted — the
 * count is compared against what the fault layers matched, so a request the
 * regex misses is neither faulted nor counted, and a resumable endpoint
 * (`?cursor=…`, `Last-Event-ID`, `?_=Date.now()`) can be hit fifty times
 * while the asserted count stays exactly right. A pattern whose whole
 * contract is a number cannot afford that, so it is a pre-flight error rather
 * than a comment.
 */
export function validateCallCountRules(
  plan: FaultPlan,
  rules: Record<string, PlanRuleTarget>,
): void {
  for (const rule of Object.keys(plan.expect.calls ?? {})) {
    const target = rules[rule];
    if (target === undefined) continue; // reported by compilePlanFaults
    const isTargetObject =
      typeof target === "object" && target !== null && !(target instanceof RegExp);
    const urlPattern = isTargetObject ? target.urlPattern : target;
    if (!isEndAnchored(urlPattern)) continue;
    const source = (urlPattern as RegExp).source;
    const flags = (urlPattern as RegExp).flags;
    const widened = `/${source.slice(0, -1)}(\\?|$)/${flags}`;
    throw new Error(
      `chaosbringer/model: plan "${plan.name}" states expect.calls on operation "${rule}", whose ` +
        `rule is the \`$\`-anchored pattern /${source}/${flags}. Under expect.calls the regex is ` +
        `not a selector, it is the definition of the number being asserted: every request that ` +
        `carries a query string — a resume cursor, a cache-buster, a page token — is neither ` +
        `faulted nor counted, so the asserted count can be exactly right while the traffic is not. ` +
        `Widen it to ${widened}, or stop asserting calls on that operation.`,
    );
  }
}

/** What the runner ended up using, and why. */
export interface ResolvedPlanTiming {
  settleMs: number;
  /**
   * Observation window after the probe. Solved from the app's deadline where
   * one is declared, else the settle window again — one more round of work,
   * in whatever unit the author already committed to.
   */
  quiescenceMs: number;
  /** Present only when `appDeadlineMs` was given. */
  solved?: TimingSolution;
  /** Milliseconds for `slow-ok` / `slow-trip`, when solvable. */
  delays?: { fastMs: number; slowMs: number };
}

/**
 * Decide the timing values for a run — before the browser launches.
 *
 * Without `appDeadlineMs` this keeps the historical behaviour (whatever
 * `settleMs` the caller wrote, or 500ms). With it, the values are solved
 * against the measured profile, and a hand-written `settleMs` is checked
 * rather than trusted: a window shorter than the app's own deadline makes a
 * correctly bounded request look stuck, and finding that out from an error
 * message beats finding it out from a false mismatch.
 */
export function resolvePlanTiming(opts: {
  settleMs?: number;
  quiescenceMs?: number;
  appDeadlineMs?: number;
  appLadder?: AppLadder;
  timingProfile?: TimingProfile;
  timeout?: number;
}): ResolvedPlanTiming {
  if (opts.appLadder !== undefined) {
    const ladder = opts.appLadder;
    if (!Number.isInteger(ladder.attempts) || ladder.attempts < 1) {
      throw new Error(
        `chaosbringer/model: appLadder.attempts must be a positive integer, got ` +
          `${JSON.stringify(ladder.attempts)} — it counts bounded attempts including the first`,
      );
    }
    if (ladder.backoffsMs.length > ladder.attempts - 1) {
      throw new Error(
        `chaosbringer/model: appLadder declares ${ladder.attempts} attempt(s) but ` +
          `${ladder.backoffsMs.length} backoff(s); there are at most attempts-1 waits between them`,
      );
    }
    if (ladder.backoffsMs.some((b) => !(b >= 0))) {
      throw new Error(
        `chaosbringer/model: appLadder.backoffsMs must all be >= 0, got ` +
          `[${ladder.backoffsMs.join(", ")}]`,
      );
    }
    if (opts.appDeadlineMs === undefined) {
      throw new Error(
        `chaosbringer/model: appLadder needs appDeadlineMs — a ladder is a number of the app's ` +
          `own bounded rounds, and without the bound there is nothing to multiply`,
      );
    }
  }
  if (opts.appDeadlineMs === undefined) {
    const settleMs = opts.settleMs ?? 500;
    // No declared app deadline means no derivation is available, so the
    // window falls back to the one number the author did commit to. Saying
    // "one more settle window" is not a measurement, but it is the same
    // order of magnitude as the work being waited for, and it is stated in
    // the docs rather than hidden.
    return { settleMs, quiescenceMs: opts.quiescenceMs ?? settleMs };
  }
  const profile = opts.timingProfile ?? DEFAULT_TIMING_PROFILE;
  const request = {
    deadlineMs: opts.appDeadlineMs,
    ...(opts.appLadder !== undefined ? { ladder: opts.appLadder } : {}),
    ...(opts.timeout !== undefined ? { budgetMs: opts.timeout } : {}),
  };
  const solved = solveTiming(profile, request);
  if (solved.status === "unsat") {
    throw new Error(
      `chaosbringer/model: no timing values can satisfy an app deadline of ${opts.appDeadlineMs}ms ` +
        `in this environment (${solved.core.join(", ")}).\n${solved.explanation}`,
    );
  }
  const quiescenceMs = opts.quiescenceMs ?? solved.quiescenceMs;
  // A hand-written window gets the same pre-flight as a hand-written settle
  // window: one too short to outlast the app's own follow-up work reports
  // "nothing escaped" about a page it stopped watching. 0 is the explicit
  // opt-out and is left alone.
  if (opts.quiescenceMs !== undefined && opts.quiescenceMs > 0) {
    const check = checkTiming(profile, request, { quiescenceMs: opts.quiescenceMs });
    if (!check.ok) {
      throw new Error(
        `chaosbringer/model: quiescenceMs=${opts.quiescenceMs} cannot outlast one more ` +
          `${opts.appDeadlineMs}ms round of work in this environment.\n${formatTimingCheck(check)}\n` +
          `Drop quiescenceMs to use the solved ${solved.quiescenceMs}ms, raise it above that, ` +
          `or set it to 0 to skip the settled re-read entirely.`,
      );
    }
  }
  if (opts.settleMs !== undefined) {
    // A declared window moves the probe, so it also moves what "too slow"
    // has to mean: `slow_outlasts_probe` is a statement about the probe
    // instant, and a tripping delay solved for a 531ms probe lands mid-window
    // when the author declared 1800ms — against an unbounded app that reads
    // as healthy. Re-derive it from the window actually being used.
    const { marginMs: margin, delayFloorMs: floor } = solved.profile;
    const slowMs = Math.max(solved.slowMs, opts.settleMs + margin - floor);
    const check = checkTiming(profile, request, { settleMs: opts.settleMs, slowMs });
    if (!check.ok) {
      throw new Error(
        `chaosbringer/model: settleMs=${opts.settleMs} cannot decide anything against a ` +
          `${opts.appDeadlineMs}ms app deadline` +
          (opts.appLadder !== undefined
            ? ` and a ladder of ${opts.appLadder.attempts} attempt(s)`
            : "") +
          `.\n${formatTimingCheck(check)}\n` +
          `Drop settleMs to use the solved ${solved.settleMs}ms, or raise it above ` +
          `${
            opts.appLadder !== undefined
              ? ladderSettleMs(
                  opts.appLadder,
                  opts.appDeadlineMs,
                  solved.profile.tightTailMs,
                  margin,
                )
              : solved.settleMs
          }ms.`,
      );
    }
    return {
      settleMs: opts.settleMs,
      quiescenceMs,
      solved,
      delays: { fastMs: solved.fastMs, slowMs },
    };
  }
  if (opts.appLadder !== undefined) {
    // The ladder is a validator, not a second solver: solving it would put a
    // window nobody asked for on every plan of a pattern that grew a retry.
    // Naming the number instead keeps the declaration in the bridge, where a
    // reviewer can see it next to the app's own constants.
    const need = ladderSettleMs(
      opts.appLadder,
      opts.appDeadlineMs,
      solved.profile.tightTailMs,
      solved.profile.marginMs,
    );
    throw new Error(
      `chaosbringer/model: appLadder declares ${opts.appLadder.attempts} attempt(s) with backoffs ` +
        `[${opts.appLadder.backoffsMs.join(", ")}], so the app's terminal state is ${need}ms away — ` +
        `but no settleMs is declared and the solved window (${solved.settleMs}ms) covers one round. ` +
        `Set settleMs to at least ${need} on the bridge, next to appDeadlineMs.`,
    );
  }
  return {
    settleMs: solved.settleMs,
    quiescenceMs,
    solved,
    delays: { fastMs: solved.fastMs, slowMs: solved.slowMs },
  };
}

/**
 * Faults that fired, keyed by fault name. Counting-only rules are excluded:
 * they exist to observe requests, not to inject, and a `rule:observe = 0`
 * entry in a map called `fired` reads like a failure.
 */
function firedCounts(report: CrawlReport, observationNames: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of report.runtimeFaults ?? []) {
    if (!observationNames.has(s.rule)) out[s.rule] = s.fired;
  }
  for (const s of report.faultInjections ?? []) {
    if (!observationNames.has(s.rule)) out[s.rule] = s.injected;
  }
  return out;
}

/**
 * Requests seen per model operation.
 *
 * Both fault layers report `matched` alongside `fired`/`injected` and the
 * runner used to throw it away, which is how a heartbeat firing 12× inside
 * one settle window produced a report byte-identical to one firing once.
 * Several faults can watch the same rule (one per outcome, plus the counting
 * rule); each sees every request on it, so the maximum is the count.
 */
function matchedCounts(
  report: CrawlReport,
  ruleOfFault: ReadonlyMap<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const note = (faultName: string, matched: number): void => {
    const rule = ruleOfFault.get(faultName);
    if (rule === undefined) return;
    out[rule] = Math.max(out[rule] ?? 0, matched);
  };
  for (const s of report.runtimeFaults ?? []) note(s.rule, s.matched);
  for (const s of report.faultInjections ?? []) note(s.rule, s.matched);
  return out;
}

/** Highest occurrence a plan pins on each rule, +1. */
function occurrenceSpans(plan: FaultPlan): Map<string, number> {
  const spans = new Map<string, number>();
  for (const step of plan.schedule) {
    spans.set(step.rule, Math.max(spans.get(step.rule) ?? 0, step.occurrence + 1));
  }
  return spans;
}


/**
 * What the page still has scheduled. `latestDueInMs` is how far out the last
 * pending `setTimeout` is; absent means nothing is due.
 */
interface PendingAsync {
  timers: number;
  intervals: number;
  latestDueInMs?: number;
}

/**
 * Instrument `setTimeout` / `setInterval` so the run can tell "no rejection
 * escaped" from "nothing had run yet".
 *
 * Installed from the invariant hook, before the action fires — which is
 * exactly when the interesting timers get scheduled, since they are the app's
 * reaction to the outcomes the plan injected. `fetch` is deliberately left
 * alone: the fault layers already own it, and wrapping it again would insert
 * a microtask into the very promise chains under test.
 */
async function installAsyncWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __cbModelAsync?: { timers: Map<unknown, number>; intervals: number };
    };
    if (w.__cbModelAsync) return;
    const state = { timers: new Map<unknown, number>(), intervals: 0 };
    w.__cbModelAsync = state;
    try {
      const origSetTimeout = window.setTimeout;
      const origClearTimeout = window.clearTimeout;
      const origSetInterval = window.setInterval;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).setTimeout = function (handler: unknown, timeout?: number, ...args: unknown[]) {
        if (typeof handler !== "function") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (origSetTimeout as any).call(window, handler, timeout, ...args);
        }
        let id: unknown;
        function wrapped(this: unknown) {
          state.timers.delete(id);
          // eslint-disable-next-line prefer-rest-params
          return (handler as (...a: unknown[]) => unknown).apply(this, arguments as unknown as unknown[]);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id = (origSetTimeout as any).call(window, wrapped, timeout, ...args);
        state.timers.set(id, Date.now() + (Number(timeout) || 0));
        return id;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).clearTimeout = function (id: unknown) {
        state.timers.delete(id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origClearTimeout as any).call(window, id);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).setInterval = function (...args: unknown[]) {
        state.intervals += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origSetInterval as any).apply(window, args);
      };
    } catch {
      // Never let instrumentation break the page under test.
    }
  });
}

async function readPendingAsync(page: Page): Promise<PendingAsync> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as {
        __cbModelAsync?: { timers: Map<unknown, number>; intervals: number };
      };
      const state = w.__cbModelAsync;
      if (!state) return { timers: 0, intervals: 0 };
      const now = Date.now();
      let timers = 0;
      let latest = -1;
      state.timers.forEach((due) => {
        if (due <= now) return;
        timers += 1;
        if (due > latest) latest = due;
      });
      return latest >= 0
        ? { timers, intervals: state.intervals, latestDueInMs: latest - now }
        : { timers, intervals: state.intervals };
    });
  } catch {
    return { timers: 0, intervals: 0 };
  }
}

/**
 * Wait for the timers the app scheduled, up to `capMs`.
 *
 * A timer can schedule another timer, so this iterates — bounded, because the
 * point is to drain the app's own follow-up work, not to wait out a polling
 * loop. What is still pending when it returns is reported, not failed on.
 */
async function drainScheduledWork(page: Page, capMs: number): Promise<PendingAsync> {
  const startedAt = Date.now();
  let pending = await readPendingAsync(page);
  for (let round = 0; round < 4; round++) {
    if (pending.latestDueInMs === undefined) return pending;
    const remaining = capMs - (Date.now() - startedAt);
    if (remaining <= 0) return pending;
    // +25ms so the callback has actually run, not merely become due.
    await page.waitForTimeout(Math.min(pending.latestDueInMs + 25, remaining));
    pending = await readPendingAsync(page);
  }
  return pending;
}

/**
 * How many rejections have escaped so far, without consuming them — the
 * crawler drains and classifies the bag after the invariant returns, and
 * stealing entries here would delete the very errors it reports.
 */
async function peekEscapedRejections(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const bag = (window as unknown as { __chaosRejections?: unknown[] }).__chaosRejections;
      return Array.isArray(bag) ? bag.length : 0;
    });
  } catch {
    return 0;
  }
}

/** Run the `"*"` invariant and the one for this label. First violation wins per key. */
export async function checkUiInvariants(
  page: Page,
  label: string | undefined,
  invariants: Record<string, UiInvariant> | undefined,
): Promise<Array<{ key: string; message: string }>> {
  if (!invariants) return [];
  const out: Array<{ key: string; message: string }> = [];
  const keys = label !== undefined && label !== "*" ? ["*", label] : ["*"];
  for (const key of keys) {
    const invariant = invariants[key];
    if (invariant === undefined) continue;
    try {
      const verdict = await invariant(page);
      if (typeof verdict === "string" && verdict.length > 0) out.push({ key, message: verdict });
    } catch (err) {
      out.push({ key, message: `invariant threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return out;
}


/** Everything `evaluatePlanOracle` needs that is not in the plan itself. */
export interface PlanOracleInput {
  plan: FaultPlan;
  observed: PlanRunResult["observed"];
  /** Fault name → planned injection count, from `compilePlanFaults`. */
  expectedInjections: ReadonlyMap<string, number>;
  /** Operation → planned call count for an all-`pass` plan, from `compilePlanFaults`. */
  expectedObservations: ReadonlyMap<string, number>;
  /** Violations reported by the bridge's `uiInvariants` at probe time. */
  uiInvariantFailures?: ReadonlyArray<{ key: string; message: string }>;
  /**
   * The same invariants re-run after the observation window. A key that was
   * already failing at probe time is reported once, as `uiInvariant`; one that
   * only fails here is `uiInvariant@late`.
   */
  uiInvariantFailuresLate?: ReadonlyArray<{ key: string; message: string }>;
  /** Whether the bridge supplied a `uiProbe` — without one `expect.ui` is skipped. */
  hasUiProbe: boolean;
  /** Whether the bridge supplied a `stateProbe`. */
  hasStateProbe: boolean;
  /** Opt-in span comparison; see `RunPlanOptions.checkAmplification`. */
  checkAmplification?: boolean;
  /** Reported in the details, so a failure names the window it was judged in. */
  settleMs: number;
  quiescenceMs: number;
}

/**
 * The oracle itself: plan + observations in, mismatches out.
 *
 * Pure and browser-free on purpose. Every check here used to live inside
 * `runPlan`, which meant the only way to test "does a duplicate write that
 * commits after the probe get caught" was to boot Chromium — so the checks
 * that were missing stayed missing. Splitting it out is what makes each of
 * them a unit test.
 */
export function evaluatePlanOracle(input: PlanOracleInput): PlanMismatch[] {
  const {
    plan,
    observed,
    expectedInjections,
    expectedObservations,
    hasUiProbe,
    hasStateProbe,
    settleMs,
    quiescenceMs,
  } = input;
  const uiInvariantFailures = input.uiInvariantFailures ?? [];
  const mismatches: PlanMismatch[] = [];

  // 1. Did every planned injection actually happen? A plan whose operation
  //    the app never calls proves nothing.
  for (const [name, expectedCount] of expectedInjections) {
    const actual = observed.fired[name] ?? 0;
    if (actual < expectedCount) {
      mismatches.push({
        plan: plan.name,
        field: "injection",
        expected: expectedCount,
        actual,
        detail:
          `${name} was scheduled ${expectedCount}× but fired ${actual}× — ` +
          `the app never issued that request, so this state was not actually exercised`,
      });
    }
  }

  // 1b. …and the same question for a plan that injects nothing. An all-`pass`
  //     schedule has no injections to check, so until now it asserted only
  //     that the page ended up with the right label — which a page serving a
  //     cache and never revalidating satisfies by doing nothing.
  for (const [rule, expectedCount] of expectedObservations) {
    const actual = observed.matched[rule] ?? 0;
    if (actual < expectedCount) {
      mismatches.push({
        plan: plan.name,
        field: "injection",
        expected: expectedCount,
        actual,
        detail:
          `operation "${rule}" was scheduled to pass ${expectedCount}× but the app issued ` +
          `${actual} request(s) on it — nothing was injected, so this plan asserted only a label`,
      });
    }
  }

  // 1c. Too *many* calls. One-sided counting is how a units bug in an
  //     interval (60ms where the author meant 60s) fires the planned outcome
  //     on call 0 exactly as predicted and then floods the endpoint forever.
  //     `expect.calls` is the model's own statement and is always checked;
  //     the span comparison needs a model that accounts for every call on
  //     that URL, so it is opt-in.
  for (const [rule, want] of Object.entries(plan.expect.calls ?? {})) {
    const actual = observed.matched[rule];
    if (actual === undefined) continue;
    if (actual !== want) {
      mismatches.push({
        plan: plan.name,
        field: "amplification",
        expected: want,
        actual,
        detail: `model predicted ${want} call(s) on "${rule}", the app made ${actual}`,
      });
    }
  }
  if (input.checkAmplification) {
    for (const [rule, span] of occurrenceSpans(plan)) {
      if (plan.expect.calls?.[rule] !== undefined) continue; // already checked, exactly
      const actual = observed.matched[rule] ?? 0;
      if (actual > span) {
        mismatches.push({
          plan: plan.name,
          field: "amplification",
          expected: span,
          actual,
          detail:
            `the plan describes ${span} call(s) on "${rule}" but the app made ${actual} — ` +
            `requests the model never accounted for, all of them reaching the endpoint`,
        });
      }
    }
  }

  // 2. The model's UI prediction — at the probe, and again after the window.
  //    The two are not symmetric, and the asymmetry is the soundness rule: a
  //    label that started wrong and converged is a page catching up (a
  //    spinner resolving, a 202 landing), so it stays one `ui` mismatch with
  //    the convergence in the detail. A label that started *right* and moved
  //    is the `Promise.race` bug: the user is told the report failed and then
  //    shown the report, from a request the app believes it abandoned.
  if (plan.expect.ui !== undefined && hasUiProbe) {
    if (observed.ui !== plan.expect.ui) {
      const converged =
        observed.uiSettled !== undefined && observed.uiSettled === plan.expect.ui;
      mismatches.push({
        plan: plan.name,
        field: "ui",
        expected: plan.expect.ui,
        actual: observed.probeError !== undefined ? `probe error: ${observed.probeError}` : observed.ui,
        detail:
          `model predicted ui="${plan.expect.ui}", page reported "${observed.ui ?? "?"}"` +
          (converged
            ? ` (and "${observed.uiSettled}" — the predicted label — ${quiescenceMs}ms later, so ` +
              `the page was still catching up when the probe fired; raise settleMs if that is the ` +
              `state you meant to judge)`
            : "") +
          (plan.schedule.every((s) => s.outcome === "pass")
            ? ` (this plan injects nothing — if "${plan.expect.ui}" is a transient state, ` +
              `it is not observable after the settle window; drop it from the target list)`
            : "") +
          (plan.schedule.some((s) => s.outcome === "hang")
            ? ` (settleMs=${settleMs}: if the app bounds this request with a longer ` +
              `timeout, the probe fires before the timeout does — raise settleMs above the app's deadline)`
            : ""),
      });
    } else if (observed.uiSettled !== undefined && observed.uiSettled !== plan.expect.ui) {
      mismatches.push({
        plan: plan.name,
        field: "ui@late",
        expected: plan.expect.ui,
        actual: observed.uiSettled,
        detail:
          `page reported the predicted ui="${plan.expect.ui}" at settleMs=${settleMs} and then ` +
          `moved to "${observed.uiSettled}" ${quiescenceMs}ms later — the label the user ends up ` +
          `with is not the one the oracle judged, so whatever the app "gave up on" is still ` +
          `running (an unbounded request behind a bounded banner)`,
      });
    }
  }

  // 2b. …and the invariants that label promises. A correct label over a wrong
  //     page is the most common shape of this whole class of bug: the banner
  //     says the price could not be revalidated, the old price is still on
  //     screen, and Pay is still enabled.
  for (const failure of uiInvariantFailures) {
    mismatches.push({
      plan: plan.name,
      field: "uiInvariant",
      expected: `${failure.key} invariant holds`,
      actual: failure.message,
      detail:
        `page reported ui="${observed.ui ?? "?"}" but the bridge's "${failure.key}" invariant ` +
        `does not hold: ${failure.message}`,
    });
  }
  // …and the same invariants one window later. A key already failing at the
  // probe is reported once, above: re-reporting it would double every hit for
  // no new information. What lands here is an invariant the page satisfied
  // when it was judged and broke afterwards — a late response overwriting a
  // list, a second render arriving after the label settled.
  const failedAtProbe = new Set(uiInvariantFailures.map((f) => f.key));
  for (const failure of input.uiInvariantFailuresLate ?? []) {
    if (failedAtProbe.has(failure.key)) continue;
    mismatches.push({
      plan: plan.name,
      field: "uiInvariant@late",
      expected: `${failure.key} invariant holds`,
      actual: failure.message,
      detail:
        `the bridge's "${failure.key}" invariant held at settleMs=${settleMs} and stopped holding ` +
        `${quiescenceMs}ms later, with ui="${observed.uiSettled ?? observed.ui ?? "?"}": ` +
        `${failure.message}`,
    });
  }

  // 3. Observables the UI does not show: write counts, refresh counts, …
  if (plan.expect.state !== undefined) {
    if (!hasStateProbe) {
      mismatches.push({
        plan: plan.name,
        field: "state",
        expected: plan.expect.state,
        actual: undefined,
        detail:
          `plan expects state ${JSON.stringify(plan.expect.state)} but the bridge has no ` +
          `stateProbe, so nothing was read — an unchecked expectation is worse than none`,
      });
    } else {
      // The *settled* read is authoritative. A backend that acknowledges a
      // write and commits it later hands the probe the number the model
      // wanted to see and the duplicate afterwards — so the value that
      // decides is the one that is still true once the observation window has
      // closed. A read that changed from a wrong value to the predicted one
      // is not reported: a slow-but-correct commit is not a bug, and calling
      // it one would make every 202-Accepted backend flake.
      const settled = observed.stateSettled ?? observed.state;
      for (const [key, want] of Object.entries(plan.expect.state)) {
        const got = settled?.[key];
        // Compare loosely on shape: a probe reading JSON gets numbers, a probe
        // reading the DOM gets strings, and the model should not have to care.
        if (String(got) !== String(want)) {
          const atProbe = observed.state?.[key];
          const drifted =
            observed.stateSettled !== undefined && String(atProbe) !== String(got);
          mismatches.push({
            plan: plan.name,
            field: "state",
            expected: want,
            actual: got,
            detail:
              `model predicted ${key}=${JSON.stringify(want)}, probe read ${JSON.stringify(got)}` +
              (drifted
                ? ` (the probe read ${JSON.stringify(atProbe)} at settleMs=${settleMs} — the ` +
                  `value the model predicted — and ${JSON.stringify(got)} ${quiescenceMs}ms later, ` +
                  `so the write was still in flight when the oracle used to decide)`
                : ""),
          });
        }
      }
    }
  }

  // 4. Did a rejection escape when the model said it must not (or vice versa)?
  //    A rejection that escaped only during the observation window gets its
  //    own field: it is not a page that was broken when the oracle looked, it
  //    is work the app scheduled and never guarded — and before the window
  //    existed it simply outlived the run.
  if (plan.expect.unhandledRejection !== undefined) {
    if (plan.expect.unhandledRejection !== observed.unhandledRejection) {
      const late = !plan.expect.unhandledRejection && observed.lateUnhandledRejection;
      mismatches.push({
        plan: plan.name,
        field: late ? "unhandledRejection@late" : "unhandledRejection",
        expected: plan.expect.unhandledRejection,
        actual: observed.unhandledRejection,
        detail: plan.expect.unhandledRejection
          ? `model predicted an escaping rejection, none was observed`
          : late
            ? `a rejection escaped every handler after the probe, from work the app scheduled ` +
              `itself (a retry, a queued write) — the model's contract forbids it, and a run ` +
              `that stopped watching at settleMs=${settleMs} would have called this clean`
            : `a rejection escaped every handler, which the model's contract forbids`,
      });
    }
  }
  return mismatches;
}

/** Replay one plan and compare the result against its oracle. */
export async function runPlan(plan: FaultPlan, opts: RunPlanOptions): Promise<PlanRunResult> {
  validatePlan(plan);

  if (plan.orderSensitive && !opts.allowOrderSensitive) {
    return {
      plan,
      skipped: "order-sensitive",
      observed: { unhandledRejection: false, lateUnhandledRejection: false, fired: {}, matched: {} },
      mismatches: [],
    };
  }

  // Resolve timing first: an impossible configuration should fail before a
  // browser is launched, not after a plan has produced a bogus verdict. Same
  // for a rule whose regex cannot see the requests its own count is about.
  validateCallCountRules(plan, opts.rules);
  const timing = resolvePlanTiming(opts);
  const settleMs = timing.settleMs;

  const { runtimeFaults, faultInjection, expectedInjections, expectedObservations, ruleOfFault } =
    compilePlanFaults(plan, opts.rules, opts.statusCode ?? 500, timing.delays);

  const observed: PlanRunResult["observed"] = {
    unhandledRejection: false,
    lateUnhandledRejection: false,
    fired: {},
    matched: {},
  };

  const asyncDrainCapMs = opts.asyncDrainCapMs ?? 3000;
  // The window is only spent where a second read can change a verdict. For
  // state that is a plan naming `expect.state`; for the UI it is a plan naming
  // `expect.ui` (or a bridge with invariants), because a label the model does
  // not predict has nothing to move away from. A plan that names neither pays
  // nothing.
  const wantsSettledState = plan.expect.state !== undefined && opts.stateProbe !== undefined;
  const wantsSettledUi =
    (plan.expect.ui !== undefined && opts.uiProbe !== undefined) ||
    opts.uiInvariants !== undefined;
  const quiescenceMs = wantsSettledState || wantsSettledUi ? timing.quiescenceMs : 0;
  let uiInvariantFailures: Array<{ key: string; message: string }> = [];
  let uiInvariantFailuresLate: Array<{ key: string; message: string }> = [];

  // The action and the probe run as an `afterLoad` invariant: that is the one
  // hook with a live page, and rejections raised here are still drained and
  // classified by the crawler's post-action pass. The invariant never fails —
  // the oracle is evaluated on the report afterwards, so an oracle miss is a
  // mismatch, not an extra error in the run it is judging.
  const oracleHook: Invariant = {
    name: `model-plan:${plan.name}`,
    when: "afterLoad",
    check: async ({ page }) => {
      try {
        if (asyncDrainCapMs > 0) await installAsyncWatch(page);
        if (opts.action) await opts.action(page);
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        if (opts.uiProbe) observed.ui = await opts.uiProbe(page);
        if (opts.stateProbe) observed.state = await opts.stateProbe(page);
        uiInvariantFailures = await checkUiInvariants(page, observed.ui, opts.uiInvariants);

        // --- observation window ---------------------------------------
        // Everything above happened at one instant. What follows decides
        // whether that instant was representative: rejections raised here are
        // still drained and classified by the crawler's post-action pass, so a
        // retry the app scheduled on the error path is observed instead of
        // outliving the run.
        const rejectionsAtProbe = await peekEscapedRejections(page);
        let pending: PendingAsync = { timers: 0, intervals: 0 };
        if (asyncDrainCapMs > 0) pending = await drainScheduledWork(page, asyncDrainCapMs);
        if (quiescenceMs > 0) await page.waitForTimeout(quiescenceMs);
        if (asyncDrainCapMs > 0) pending = await readPendingAsync(page);
        observed.pendingAsync = pending;
        if (wantsSettledState && opts.stateProbe) {
          observed.stateSettled = await opts.stateProbe(page);
        }
        if (wantsSettledUi) {
          if (opts.uiProbe) observed.uiSettled = await opts.uiProbe(page);
          uiInvariantFailuresLate = await checkUiInvariants(
            page,
            observed.uiSettled ?? observed.ui,
            opts.uiInvariants,
          );
        }
        observed.lateUnhandledRejection = (await peekEscapedRejections(page)) > rejectionsAtProbe;
      } catch (err) {
        observed.probeError = err instanceof Error ? err.message : String(err);
      }
      return true;
    },
  };

  const { report } = await chaos({
    baseUrl: opts.baseUrl,
    maxPages: 1,
    maxActionsPerPage: 0,
    headless: opts.headless ?? true,
    seed: opts.seed ?? 1,
    // A solved page timeout beats the default: it is derived from the same
    // profile as the settle window, so the run cannot be killed mid-probe.
    timeout: opts.timeout ?? timing.solved?.pageTimeoutMs ?? 15000,
    ...(runtimeFaults.length > 0 ? { runtimeFaults } : {}),
    ...(faultInjection.length > 0 ? { faultInjection } : {}),
    ...(opts.coverageFingerprints ? { coverageFeedback: { enabled: true } } : {}),
    invariants: [oracleHook],
  });

  // Every counting-only rule, not just the ones an all-`pass` plan requires:
  // a `refresh:observe = 0` entry in a map called `fired` reads like a failure.
  observed.fired = firedCounts(
    report,
    new Set(
      [...ruleOfFault]
        .filter(([name, rule]) => name === observationNameFor(rule))
        .map(([name]) => name),
    ),
  );
  observed.matched = matchedCounts(report, ruleOfFault);
  observed.unhandledRejection = report.summary.unhandledRejections > 0;
  if (report.coverageFingerprint !== undefined) {
    observed.coverageFingerprint = report.coverageFingerprint;
  }

  const mismatches = evaluatePlanOracle({
    plan,
    observed,
    expectedInjections,
    expectedObservations,
    uiInvariantFailures,
    uiInvariantFailuresLate,
    hasUiProbe: opts.uiProbe !== undefined,
    hasStateProbe: opts.stateProbe !== undefined,
    ...(opts.checkAmplification !== undefined ? { checkAmplification: opts.checkAmplification } : {}),
    settleMs,
    quiescenceMs,
  });

  return { plan, observed, mismatches, report };
}

/** Replay a set of plans in sequence. Order is stable for reproducible reports. */
export async function runPlans(
  plans: readonly FaultPlan[],
  opts: RunPlanOptions,
): Promise<PlanRunResult[]> {
  const results: PlanRunResult[] = [];
  for (const plan of plans) {
    results.push(await runPlan(plan, opts));
  }
  return results;
}

/**
 * Per-plan coverage digests, ready for `aggregateCoverage({ fingerprints })`.
 * Empty unless the run was made with `coverageFingerprints: true`.
 */
export function fingerprintsOf(results: readonly PlanRunResult[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of results) {
    if (r.observed.coverageFingerprint !== undefined) {
      out.set(r.plan.name, r.observed.coverageFingerprint);
    }
  }
  return out;
}
