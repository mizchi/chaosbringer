/**
 * Replay a `FaultPlan` in a real browser and check the model's oracle.
 *
 * One plan = one `chaos()` run = one user action, with every operation's
 * outcome pinned by an occurrence-indexed fault schedule. No probabilities
 * are involved, so a plan either reproduces or reports why it could not:
 *
 *   - the UI ended somewhere the model didn't predict        → `ui` mismatch
 *   - a rejection escaped (or failed to escape) every handler → `unhandledRejection`
 *   - the app never issued a request the plan was waiting for → `injection`
 *
 * That last one matters: without it a plan whose operation is never called
 * looks like a pass, and the coverage claim becomes a lie.
 */

import type { Page } from "playwright";
import { chaos } from "../chaos.js";
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
};

export interface RunPlanOptions {
  /** Page to open. The modelled action runs on this page after load. */
  baseUrl: string;
  /** Model operation id → URL matcher. Every rule a plan references must be here. */
  rules: Record<string, UrlMatcher>;
  /**
   * Fire the modelled user action (click "Load", submit the form, …). Omit
   * for models whose operations are issued by page load itself.
   */
  action?: (page: Page) => Promise<void>;
  /** Map the page back to the model's UI vocabulary. Omit to skip `ui` checks. */
  uiProbe?: (page: Page) => Promise<string>;
  /** Quiet period after the action before probing. Default 500ms. */
  settleMs?: number;
  /** Page timeout, forwarded to the crawler. Default 15000ms. */
  timeout?: number;
  /** Default true. */
  headless?: boolean;
  /** Seed, forwarded to the crawler. Default 1 (plans don't use the RNG). */
  seed?: number;
  /** HTTP status used for `status` outcomes. Default 500. */
  statusCode?: number;
  /** Run plans flagged `orderSensitive` anyway. Default false. */
  allowOrderSensitive?: boolean;
}

export type MismatchField = "ui" | "unhandledRejection" | "injection";

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
    unhandledRejection: boolean;
    /** Faults that fired, keyed by `${rule}:${outcome}`. */
    fired: Record<string, number>;
    /** Thrown by `action` / `uiProbe`, if either did. */
    probeError?: string;
  };
  mismatches: PlanMismatch[];
  /** The underlying crawl report — artifacts, errors, timings. */
  report?: CrawlReport;
}

/** Stable fault name so post-run stats can be attributed back to a step. */
export function faultNameFor(rule: string, outcome: PlanOutcome): string {
  return `${rule}:${outcome}`;
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
  rules: Record<string, UrlMatcher>,
  statusCode = 500,
): { runtimeFaults: RuntimeFault[]; faultInjection: FaultRule[]; expectedInjections: Map<string, number> } {
  const byRule = new Map<string, PlanStep[]>();
  for (const step of plan.schedule) {
    const bucket = byRule.get(step.rule);
    if (bucket) bucket.push(step);
    else byRule.set(step.rule, [step]);
  }

  const runtimeFaults: RuntimeFault[] = [];
  const faultInjection: FaultRule[] = [];
  const expectedInjections = new Map<string, number>();

  for (const [rule, steps] of byRule) {
    const urlPattern = rules[rule];
    if (urlPattern === undefined) {
      throw new Error(
        `chaosbringer/model: plan "${plan.name}" references operation "${rule}" with no entry in \`rules\``,
      );
    }

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
      const schedule = { decisions, afterEnd: "pass" as const };

      switch (outcome) {
        case "reject":
          runtimeFaults.push({
            name,
            urlPattern,
            schedule,
            action: { kind: "reject-fetch", rejectAs: "TypeError", rejectionMessage: `model:${name}` },
          });
          break;
        case "abort":
          runtimeFaults.push({
            name,
            urlPattern,
            schedule,
            action: { kind: "reject-fetch", rejectAs: "AbortError", rejectionMessage: `model:${name}` },
          });
          break;
        case "reject-body":
          runtimeFaults.push({
            name,
            urlPattern,
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
            schedule,
            action: { kind: "never-settle-fetch" },
          });
          break;
        case "status":
          faultInjection.push({
            name,
            urlPattern,
            schedule,
            fault: { kind: "status", status: statusCode },
          });
          break;
        case "pass":
          break;
      }
    }
  }

  return { runtimeFaults, faultInjection, expectedInjections };
}

function firedCounts(report: CrawlReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of report.runtimeFaults ?? []) out[s.rule] = s.fired;
  for (const s of report.faultInjections ?? []) out[s.rule] = s.injected;
  return out;
}

/** Replay one plan and compare the result against its oracle. */
export async function runPlan(plan: FaultPlan, opts: RunPlanOptions): Promise<PlanRunResult> {
  validatePlan(plan);

  if (plan.orderSensitive && !opts.allowOrderSensitive) {
    return {
      plan,
      skipped: "order-sensitive",
      observed: { unhandledRejection: false, fired: {} },
      mismatches: [],
    };
  }

  const { runtimeFaults, faultInjection, expectedInjections } = compilePlanFaults(
    plan,
    opts.rules,
    opts.statusCode ?? 500,
  );

  const observed: PlanRunResult["observed"] = { unhandledRejection: false, fired: {} };
  const settleMs = opts.settleMs ?? 500;

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
        if (opts.action) await opts.action(page);
        if (settleMs > 0) await page.waitForTimeout(settleMs);
        if (opts.uiProbe) observed.ui = await opts.uiProbe(page);
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
    timeout: opts.timeout ?? 15000,
    ...(runtimeFaults.length > 0 ? { runtimeFaults } : {}),
    ...(faultInjection.length > 0 ? { faultInjection } : {}),
    invariants: [oracleHook],
  });

  observed.fired = firedCounts(report);
  observed.unhandledRejection = report.summary.unhandledRejections > 0;

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

  // 2. The model's UI prediction.
  if (plan.expect.ui !== undefined && opts.uiProbe) {
    if (observed.ui !== plan.expect.ui) {
      mismatches.push({
        plan: plan.name,
        field: "ui",
        expected: plan.expect.ui,
        actual: observed.probeError !== undefined ? `probe error: ${observed.probeError}` : observed.ui,
        detail: `model predicted ui="${plan.expect.ui}", page reported "${observed.ui ?? "?"}"`,
      });
    }
  }

  // 3. Did a rejection escape when the model said it must not (or vice versa)?
  if (plan.expect.unhandledRejection !== undefined) {
    if (plan.expect.unhandledRejection !== observed.unhandledRejection) {
      mismatches.push({
        plan: plan.name,
        field: "unhandledRejection",
        expected: plan.expect.unhandledRejection,
        actual: observed.unhandledRejection,
        detail: plan.expect.unhandledRejection
          ? `model predicted an escaping rejection, none was observed`
          : `a rejection escaped every handler, which the model's contract forbids`,
      });
    }
  }

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
