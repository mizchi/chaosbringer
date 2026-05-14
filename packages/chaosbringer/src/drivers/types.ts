/**
 * Driver abstraction.
 *
 * A `Driver` picks the next action on a page during the chaos crawl loop.
 * Implementations range from the original weighted-random heuristic to a
 * per-step AI (`aiDriver`) that asks a vision model what to click. Drivers
 * compose: `compositeDriver`, `samplingDriver`, and `advisorFallbackDriver`
 * let users mix cheap heuristics with occasional model calls without
 * forking the crawler loop.
 *
 * The crawler enriches each `DriverStep` with the current candidate list,
 * recent history, and a `screenshot()` thunk so providers can lazily pay
 * the capture cost only when they actually consult a model.
 */
import type { Page } from "playwright";
import type { Rng } from "../random.js";
import type { ActionResult, ActionTarget } from "../types.js";

export interface DriverCandidate {
  /** Stable index into the candidates array — what `select` returns. */
  index: number;
  /** Playwright selector. Internal — do not send to model providers. */
  selector: string;
  /** Human-readable role + accessible name + visible text snippet. */
  description: string;
  type: ActionTarget["type"];
  weight: number;
  href?: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface DriverHistoryEntry {
  type: ActionResult["type"];
  target?: string;
  success: boolean;
  error?: string;
}

export interface DriverInvariantViolation {
  name: string;
  message: string;
}

export type ScreenshotMode = "viewport" | "fullPage";

export interface DriverStep {
  url: string;
  /** Raw page handle for drivers that need to inspect/interact directly. */
  page: Page;
  candidates: ReadonlyArray<DriverCandidate>;
  /** Most recent action results on this page, oldest first. */
  history: ReadonlyArray<DriverHistoryEntry>;
  /** Step index within the current page (0-based). */
  stepIndex: number;
  /** Deterministic RNG. Drivers that randomise MUST use this. */
  rng: Rng;
  /** Lazy screenshot — only captured when a driver actually asks for it. */
  screenshot: (mode?: ScreenshotMode) => Promise<Buffer>;
  /** Invariant violations observed since the previous step. */
  invariantViolations: ReadonlyArray<DriverInvariantViolation>;
}

export type DriverPick =
  | {
      kind: "select";
      /** Index into `step.candidates`. */
      index: number;
      /** Optional explanation, stored in the trace for debugging. */
      reasoning?: string;
      /** Optional source tag for reporting (e.g. provider name). */
      source?: string;
    }
  | {
      /**
       * The driver wants to perform a sequence of actions itself (e.g. fill a
       * whole form). `perform` is called with the page; whatever
       * `ActionResult` it returns is recorded as the step's result. Use this
       * for multi-step operations that cannot be expressed as picking one
       * candidate. The crawler still counts this as one chaos action.
       */
      kind: "custom";
      perform: (page: import("playwright").Page) => Promise<ActionResult>;
      reasoning?: string;
      source?: string;
    }
  | {
      /** Skip this step — the crawler moves on. Used by samplers / budgets. */
      kind: "skip";
    };

export interface Driver {
  readonly name: string;
  /**
   * Choose what to do this step. Return `null` to defer to the surrounding
   * composite / fallback driver. The crawler treats a top-level `null` as
   * "skip this step".
   */
  selectAction(step: DriverStep): Promise<DriverPick | null>;
  /**
   * Optional feedback hook. Called after the crawler executes the action
   * the driver picked. Use for stall trackers, novelty memory, etc.
   */
  onActionComplete?(action: ActionResult, step: DriverStep): void;
  onPageStart?(url: string): void;
  onPageEnd?(url: string): void;
}

/**
 * Low-level provider — the thing that actually talks to a model.
 * Drivers (`aiDriver`) own the policy (when to call, how to budget); the
 * provider owns the wire protocol (OpenRouter, Anthropic SDK, etc.).
 */
export interface DriverProvider {
  readonly name: string;
  selectAction(input: DriverProviderInput): Promise<DriverProviderResult | null>;
}

export interface DriverProviderInput {
  url: string;
  screenshot: Buffer;
  candidates: ReadonlyArray<{ index: number; description: string }>;
  history: ReadonlyArray<DriverHistoryEntry>;
  invariantViolations: ReadonlyArray<DriverInvariantViolation>;
  /** Free-form goal hint forwarded by the driver — e.g. "find bugs". */
  goal?: string;
  /** Step index in the current page (0-based). */
  stepIndex: number;
}

export interface DriverProviderResult {
  /** Index in the candidates array the provider chose. */
  index: number;
  reasoning: string;
  confidence?: number;
}
