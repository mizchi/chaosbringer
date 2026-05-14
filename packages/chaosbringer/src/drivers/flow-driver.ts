/**
 * `flowDriver` — execute a scripted journey across pages.
 *
 * Use when you have a known critical path (register → verify → login →
 * onboard → buy) and want the chaos crawler to exercise it under fault
 * injection. The driver advances through a list of steps; each step
 * has an optional `when` predicate (defaults to URL match) so the
 * driver waits patiently when the crawler is on an unrelated page.
 *
 * Pair with `compositeDriver([flowDriver(steps), weightedRandomDriver()])`
 * so the flow drives the happy path while random exploration runs in
 * parallel on pages the flow doesn't claim. Once every step in the
 * journey has completed, the driver returns null forever (one-shot).
 */
import type { Page } from "playwright";
import type { ActionResult } from "../types.js";
import type { Driver, DriverPick, DriverStep } from "./types.js";

export interface FlowStep {
  /** Human-readable label, used in trace + logs. */
  name: string;
  /**
   * Predicate that decides whether this step is ready to run on the
   * current page. Defaults to matching `urlPattern`; either may be
   * provided. If neither is set, the step matches any URL (use sparingly).
   */
  when?: (step: DriverStep) => boolean | Promise<boolean>;
  urlPattern?: RegExp | string;
  /**
   * The actual journey action. Operate on the page directly.
   * Throw to mark the step failed; return value is ignored.
   */
  run: (page: Page, step: DriverStep) => Promise<void>;
  /**
   * If true, the flow advances even if `run` throws. Default: false
   * (a failing step halts the flow so subsequent steps don't run
   * against a broken state).
   */
  optional?: boolean;
}

export interface FlowDriverOptions {
  steps: ReadonlyArray<FlowStep>;
  /** Restart the flow when the last step has completed. Default: false. */
  loop?: boolean;
  name?: string;
}

function matchesUrl(pattern: RegExp | string, url: string): boolean {
  if (typeof pattern === "string") return url.includes(pattern);
  return pattern.test(url);
}

async function stepMatches(s: FlowStep, ctx: DriverStep): Promise<boolean> {
  if (s.when) return s.when(ctx);
  if (s.urlPattern) return matchesUrl(s.urlPattern, ctx.url);
  return true;
}

export function flowDriver(options: FlowDriverOptions): Driver {
  if (options.steps.length === 0) {
    throw new Error("flowDriver: steps is empty");
  }
  const loop = options.loop ?? false;
  let cursor = 0;
  let halted = false;

  return {
    name: options.name ?? `flow(${options.steps.length})`,

    async selectAction(ctx: DriverStep): Promise<DriverPick | null> {
      if (halted) return null;
      if (cursor >= options.steps.length) {
        if (!loop) return null;
        cursor = 0;
      }
      const step = options.steps[cursor]!;
      const ready = await stepMatches(step, ctx);
      if (!ready) return null;

      const here = cursor;
      return {
        kind: "custom",
        source: `flow/${step.name}`,
        reasoning: `flow step ${here + 1}/${options.steps.length}: ${step.name}`,
        async perform(page): Promise<ActionResult> {
          const timestamp = Date.now();
          try {
            await step.run(page, ctx);
            cursor += 1;
            return {
              type: "input",
              target: `flow:${step.name}`,
              success: true,
              timestamp,
            };
          } catch (err) {
            if (step.optional) {
              cursor += 1;
            } else {
              halted = true;
            }
            return {
              type: "input",
              target: `flow:${step.name}`,
              success: false,
              error: err instanceof Error ? err.message : String(err),
              timestamp,
            };
          }
        },
      };
    },

    onPageStart() {
      // Stateful flows reset nothing here; the cursor is intentionally
      // preserved across page transitions because the journey IS
      // cross-page.
    },
  };
}
