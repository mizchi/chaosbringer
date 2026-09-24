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
import type { ActionResult, ActionTarget, LastActionPerf } from "../types.js";

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
  /**
   * For a `select` candidate, the option value the crawler will set if
   * this candidate is picked — one the page itself offered.
   *
   * Here because an index alone does not say what will happen: picking a
   * dropdown asks for a *value*, and a driver that cannot see which one
   * is choosing the element and guessing the rest.
   */
  selectValue?: string;
  /**
   * Viewport-relative box, so a prompt can cite "the button at top-right".
   * Absent on the `scroll` target and when the scrape failed.
   */
  bbox?: { x: number; y: number; width: number; height: number };
  /**
   * The box overlaps the viewport. **Not a reason to skip a candidate** —
   * Playwright scrolls before acting — but it is the condition under which
   * `coveredBy` was measured.
   */
  inViewport?: boolean;
  /**
   * The element that will receive a click aimed here, when it is not this
   * one. The fact a description cannot carry: `button "Continue"` reads
   * the same whether the button is live or under a consent backdrop that
   * eats the click, and the click then silently does nothing.
   *
   * Set only when `inViewport` is true, so absent means "nothing found on
   * top", not "nothing is on top". Prefer `isObstructed` over reading this
   * directly — it gets that distinction right.
   */
  coveredBy?: string;
  /** `pointer-events: none`: a click aimed here passes through. */
  inert?: boolean;
}

/**
 * Does the geometry say a click aimed at this candidate lands elsewhere?
 *
 * True only on positive evidence. An off-screen candidate, a `scroll`
 * target, and anything from a page that could not be scraped all come back
 * `false`, because "we do not know" and "it is fine" have to be answered
 * the same way here: a false positive makes a driver skip a control that
 * works, which is worse than the wasted step it was trying to avoid.
 *
 * The measured case for using it, from a gated-checkout SPA with a
 * transparent full-screen backdrop left behind by a styled-away tip card:
 * of 13 steps that changed nothing, this flagged 12, and every one of the
 * 12 was a real dead click. The confidence the model reported on those
 * same picks was 0.99 or above — it had no way to know.
 *
 * ```ts
 * const liveOnly: Driver = {
 *   name: "live-only",
 *   async selectAction(step) {
 *     const live = step.candidates.filter((c) => !isObstructed(c));
 *     // Fall back to the full list rather than returning null: a screen
 *     // whose every control is blocked still has to be leavable.
 *     const pick = (live.length > 0 ? live : step.candidates)[0];
 *     return pick ? { kind: "select", index: pick.index } : null;
 *   },
 * };
 * ```
 *
 * Takes the two fields it reads rather than a whole `DriverCandidate`, so
 * the model-facing candidate types can be handed to it too — a provider
 * that is given the geometry has to be able to ask the question the same
 * way a hand-written driver does.
 */
export function isObstructed(candidate: {
  inert?: boolean;
  coveredBy?: string;
}): boolean {
  return candidate.inert === true || candidate.coveredBy !== undefined;
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
  /**
   * The URL of the page *visit* this loop belongs to — what the crawl
   * queued and what `onPageStart` / budgets key off. Stable for every step
   * on the page, so it does not follow in-page routing.
   */
  url: string;
  /**
   * The live URL as of this step (`page.url()`). On an app that routes by
   * hash or History API without a fresh page visit, `url` stays where the
   * crawl queued and `currentUrl` follows the route the user is actually
   * looking at. Prefer this when reporting or remembering "where am I".
   */
  currentUrl: string;
  /** Raw page handle for drivers that need to inspect/interact directly. */
  page: Page;
  /**
   * The controls the page offers *right now* — re-collected from the DOM
   * before every step, so `index` is only valid for this step.
   */
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
  /**
   * What the previous action on this page cost — the last `history` entry's
   * span. Present only with `perf` on (and `perf.actions` not false) and
   * only once an action on this page was measured; absent, never zeroed,
   * otherwise. `key` is that action's perfKey (`candidatePerfKey` gives the
   * same key for a candidate, so a driver can join the two). See
   * `LastActionPerf`.
   */
  lastActionPerf?: LastActionPerf;
}

/**
 * What to do to the candidate, when the default is not it.
 *
 * A `select` pick normally names an element and nothing else: the crawler
 * performs the one action the scraped `type` implies, and for an `input`
 * that is a fill with a value `fillValueFor` derived from the field's
 * `inputType`. Always a non-empty one — so a driver picking by index can
 * put text into a field and can never take it out.
 *
 * `clear` is the missing end state. `fill()` replaces, so clearing is not
 * needed to *change* a value; an empty field is a state of its own, and
 * the value seam that can reach it (`FieldValueProvider`, whose
 * `boundaryValueProvider` already offers `""`) belongs to `formDriver`,
 * which writes every field of a form at once. "Empty this one field and
 * leave the rest valid" is the case neither path expresses.
 *
 * Deliberately one operation, not a general operation-and-value pick:
 * letting a driver choose the text too is a larger question about who
 * owns the value, and it wants the provider seam thought through with it.
 */
export type DriverOperation = "clear";

export type DriverPick =
  | {
      kind: "select";
      /** Index into `step.candidates`. */
      index: number;
      /**
       * Override what is done to the candidate. Omit for the crawler's
       * default. `"clear"` requires a candidate with `type: "input"` —
       * the class `fill()` accepts, and so the class `clear()` accepts.
       * On anything else the pick is refused like an out-of-range index:
       * the step is not spent and the driver is asked again.
       */
      operation?: DriverOperation;
      /** Optional explanation, stored in the trace for debugging. */
      reasoning?: string;
      /** Optional source tag for reporting (e.g. provider name). */
      source?: string;
      /**
       * How sure the picker is, 0..1, when it can say. Recorded in the
       * trace so a run can be audited for the picks it was unsure about;
       * `aiDriver`'s `minConfidence` turns it into a fallback trigger.
       */
      confidence?: number;
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
 *
 * A provider is handed the facts, not a rendering of them: the candidate
 * list carries `type` and the hit-test geometry, and the screenshot is a
 * thunk. A provider that reasons over text alone therefore costs one HTTP
 * call and no capture.
 */
export interface DriverProvider {
  readonly name: string;
  selectAction(input: DriverProviderInput): Promise<DriverProviderResult | null>;
}

/**
 * What a provider is allowed to see about one candidate: everything the
 * scrape measured, minus the selector.
 *
 * Derived rather than hand-listed so the rule is the type. `selector` is
 * internal — a model that is shown one starts citing it back, and a pick
 * is an `index` into this array precisely so the mapping from answer to
 * element stays on this side. Every other field is a fact about the page
 * and belongs on the other side of the seam: `type` says whether the
 * candidate takes a click or a value, and the geometry says whether a
 * click aimed at it lands (see `isObstructed`) — which is exactly what
 * `description` cannot carry.
 */
export type DriverProviderCandidate = Omit<DriverCandidate, "selector">;

export interface DriverProviderInput {
  url: string;
  /**
   * Capture the page, when the provider actually reads pixels. Lazy: a
   * text-only provider that never calls this pays nothing for it, and a
   * capture that fails surfaces as the provider's own soft failure rather
   * than standing the driver down before it was ever consulted.
   *
   * Each call captures — call it once. `mode` defaults to the driver's
   * configured `screenshotMode`.
   */
  screenshot: (mode?: ScreenshotMode) => Promise<Buffer>;
  candidates: ReadonlyArray<DriverProviderCandidate>;
  history: ReadonlyArray<DriverHistoryEntry>;
  invariantViolations: ReadonlyArray<DriverInvariantViolation>;
  /** Free-form goal hint forwarded by the driver — e.g. "find bugs". */
  goal?: string;
  /**
   * `DriverStep.lastActionPerf` without its `key`: the key embeds the
   * action's selector, and a selector never crosses this seam. Absent
   * under the same conditions.
   */
  lastActionPerf?: Omit<LastActionPerf, "key">;
  /** Step index in the current page (0-based). */
  stepIndex: number;
}

export interface DriverProviderResult {
  /** Index in the candidates array the provider chose. */
  index: number;
  reasoning: string;
  confidence?: number;
}
