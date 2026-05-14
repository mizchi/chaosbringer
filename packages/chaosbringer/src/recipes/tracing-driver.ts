/**
 * `tracingDriver` — wraps any `Driver` and accumulates the steps it
 * picks into an `ActionTrace`. When the wrapped Goal's `successCheck`
 * flips true, the trace is marked successful and `onTraceComplete`
 * fires exactly once.
 *
 * Phase A of the AI flywheel: a goal-directed run with an AI driver
 * captures every successful trajectory. The caller pipes those traces
 * through `extractCandidate()` + `store.upsert()` to grow the skill
 * library; subsequent runs replay the verified recipes for free.
 *
 * Action → RecipeStep mapping is conservative — we capture the
 * verbs that round-trip safely (click, navigate, fill) and skip the
 * rest (scroll, hover). A captured recipe with no fills will still
 * replay; a captured recipe with the wrong fill value WON'T, so we'd
 * rather drop than fake.
 */
import type { Page } from "playwright";
import type { ActionResult } from "../types.js";
import type { Driver, DriverPick, DriverStep } from "../drivers/types.js";
import type { ActionTrace, Goal, RecipeStep } from "./types.js";

export interface TracingDriverOptions {
  /** Driver to delegate to — typically `aiDriver` or a `compositeDriver`. */
  inner: Driver;
  /** Goal whose `successCheck` decides when the trace is finalised. */
  goal: Goal;
  /** Fires once when `successCheck` first returns true. */
  onTraceComplete?: (trace: ActionTrace) => Promise<void> | void;
  /**
   * When the AI driver fills a form, the fill *value* is not part of
   * the `ActionResult`. By default we serialise as `"test input"` —
   * the same string the crawler uses — but real form journeys need a
   * caller-provided overrider keyed by selector.
   */
  fillValueFor?: (selector: string, step: DriverStep) => string | undefined;
  /**
   * Per-step screenshot capture. browser-harness doctrine: "after
   * every meaningful action, re-screenshot before assuming it worked."
   * Enable for AI-driver runs where downstream `investigate()` will
   * need visual context to diagnose recipe drift.
   *
   * Paths are absolute. The caller owns disk hygiene (rotating /
   * deleting old runs) — we never clean up automatically.
   */
  screenshots?: {
    /** Output directory. Created if missing. */
    dir: string;
    /** "viewport" (default) or "fullPage". */
    mode?: "viewport" | "fullPage";
    /**
     * Filename strategy. Default: `step-${index}-${kind}.png`.
     * Override when you need a stable, run-scoped naming convention.
     */
    filenameFor?: (stepIndex: number, kind: RecipeStep["kind"]) => string;
  };
}

export interface TracingDriver extends Driver {
  /** Snapshot of the trace as currently accumulated. */
  getTrace(): ActionTrace;
  /** Reset between iterations so the same wrapper can be reused. */
  reset(): void;
}

export function tracingDriver(opts: TracingDriverOptions): TracingDriver {
  let trace: ActionTrace | null = null;
  let startTimeMs = 0;
  let emitted = false;
  const errorBuffer: Array<{ message: string; timestamp: number }> = [];
  let errorHookInstalledFor: Page | null = null;
  let screenshotsEnsured = false;
  // Lazy-load fs only when screenshots are enabled, so non-screenshot
  // users don't pay an import cost on a browser-context environment.
  const captureScreenshot = async (page: Page, stepIndex: number, kind: RecipeStep["kind"]): Promise<string | null> => {
    if (!opts.screenshots) return null;
    const { dir, mode, filenameFor } = opts.screenshots;
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    if (!screenshotsEnsured) {
      mkdirSync(dir, { recursive: true });
      screenshotsEnsured = true;
    }
    const filename = filenameFor
      ? filenameFor(stepIndex, kind)
      : `step-${String(stepIndex).padStart(3, "0")}-${kind}.png`;
    const path = join(dir, filename);
    try {
      await page.screenshot({ path, fullPage: mode === "fullPage" });
      return path;
    } catch {
      return null;
    }
  };

  function installErrorHook(page: Page): void {
    if (errorHookInstalledFor === page) return;
    errorHookInstalledFor = page;
    page.on("pageerror", (err) => {
      errorBuffer.push({ message: err.message, timestamp: Date.now() });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errorBuffer.push({ message: msg.text(), timestamp: Date.now() });
      }
    });
  }

  function ensureTrace(startUrl?: string): ActionTrace {
    if (!trace) {
      startTimeMs = Date.now();
      trace = {
        goal: opts.goal.name,
        steps: [],
        startState: { url: startUrl ?? "" },
        endState: { url: startUrl ?? "" },
        durationMs: 0,
        successful: false,
        screenshots: opts.screenshots ? [] : undefined,
      };
    }
    return trace;
  }

  return {
    name: "tracing",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      installErrorHook(step.page);
      const current = ensureTrace(step.page.url());
      if (!emitted) {
        const ok = await opts.goal.successCheck({
          page: step.page,
          url: step.page.url(),
          history: current.steps,
          errors: errorBuffer,
        }).catch(() => false);
        if (ok) {
          current.successful = true;
          current.endState = { url: step.page.url() };
          current.durationMs = Date.now() - startTimeMs;
          emitted = true;
          await opts.onTraceComplete?.(current);
        }
      }
      return opts.inner.selectAction(step);
    },
    onActionComplete(action: ActionResult, step: DriverStep): void {
      const current = trace ?? ensureTrace(step.page.url());
      if (!emitted && action.success) {
        const recipeStep = actionToRecipeStep(action, step, opts.fillValueFor);
        if (recipeStep) {
          current.steps.push(recipeStep);
          if (opts.screenshots && current.screenshots) {
            // Screenshot capture is async; we kick it off without
            // blocking the driver loop. The recipe step is already
            // pushed — the screenshot path is recorded once the
            // capture resolves, indexed by step position.
            const idx = current.steps.length - 1;
            // Reserve the slot so screenshots[] stays parallel to steps[]
            current.screenshots[idx] = "";
            void captureScreenshot(step.page, idx, recipeStep.kind).then((path) => {
              if (path && current.screenshots) current.screenshots[idx] = path;
            });
          }
        }
        current.endState = { url: step.page.url() };
        current.durationMs = Date.now() - startTimeMs;
      }
      opts.inner.onActionComplete?.(action, step);
    },
    onPageStart(url: string): void {
      opts.inner.onPageStart?.(url);
    },
    onPageEnd(url: string): void {
      opts.inner.onPageEnd?.(url);
    },
    getTrace(): ActionTrace {
      // Lazy-init so callers (e.g. `investigate()`) can finalise the
      // trace before the inner driver ever runs.
      return ensureTrace();
    },
    reset(): void {
      trace = null;
      startTimeMs = 0;
      emitted = false;
      errorBuffer.length = 0;
      errorHookInstalledFor = null;
    },
  };
}

function actionToRecipeStep(
  action: ActionResult,
  step: DriverStep,
  fillValueFor?: (selector: string, step: DriverStep) => string | undefined,
): RecipeStep | null {
  switch (action.type) {
    case "click": {
      if (!action.selector) return null;
      return { kind: "click", selector: action.selector };
    }
    case "input": {
      if (!action.selector) return null;
      const value = fillValueFor?.(action.selector, step) ?? "test input";
      return { kind: "fill", selector: action.selector, value };
    }
    case "navigate": {
      if (!action.target) return null;
      try {
        // Relative URLs (the crawler emits absolute, but be lenient).
        const absolute = new URL(action.target, step.url).toString();
        return { kind: "navigate", url: absolute };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}
