/**
 * Public types for the action advisor. The advisor is an opt-in second
 * opinion the crawler consults rarely (budgeted) when its
 * coverage-guided heuristic stalls. Default reference provider
 * (OpenRouter google/gemini-2.5-flash) lands in a follow-up PR per
 * `docs/superpowers/specs/2026-05-01-vlm-action-advisor-design.md` §10.
 */
import type { ActionTarget, LastActionPerf } from "../types.js";

export interface AdvisorCandidate {
  /** Stable index inside the candidate batch. The advisor returns this. */
  index: number;
  /** Playwright selector — internal only, not sent to the model. */
  selector: string;
  /** What the model sees: role + accessible name + visible text. */
  description: string;
  /** Whether it takes a click or a value. From `ActionTarget.type`. */
  type: ActionTarget["type"];
  /** Optional bbox in viewport coords; lets the prompt cite "the button at top-right". */
  bbox?: { x: number; y: number; width: number; height: number };
  /**
   * The box has area and overlaps the viewport — the condition under
   * which `coveredBy` was measured, and **not** a reason to skip a
   * candidate. See `TargetGeometry` in `../types.ts`.
   */
  inViewport?: boolean;
  /**
   * What will receive a click aimed here, when it is not this candidate.
   * The fact a description cannot carry: `button "Continue"` reads the
   * same whether the button is live or under a consent backdrop that
   * eats the click. Prefer `isObstructed` over reading this directly —
   * absent means "nothing found on top", not "nothing is on top".
   */
  coveredBy?: string;
  /** `pointer-events: none`: a click aimed here passes through. */
  inert?: boolean;
}

export type AdvisorConsultReason =
  | "novelty_stall"
  | "invariant_violation"
  | "explicit_request";

export interface AdvisorContext {
  url: string;
  /**
   * Capture the page as PNG bytes, when the advisor actually reads
   * pixels. Lazy: a text-only advisor that never calls this pays nothing
   * for it, and a capture that fails becomes this consult's soft failure
   * (`outcome: "threw"`) instead of propagating out of the crawl.
   *
   * Each call captures — call it once.
   */
  screenshot: () => Promise<Buffer>;
  candidates: AdvisorCandidate[];
  /** Why the crawler is asking — drives prompt framing. */
  reason: AdvisorConsultReason;
  /** How many advisor calls remain in this crawl, after this one. */
  budgetRemaining: number;
  /**
   * What the previous action on this page cost; the same fact, under the
   * same rules, as `DriverStep.lastActionPerf` — absent unless perf is on
   * and an action on this page was measured. `key` embeds the action's
   * selector, which, like `AdvisorCandidate.selector`, is not for the model.
   */
  lastActionPerf?: LastActionPerf;
}

export interface AdvisorSuggestion {
  chosenIndex: number;
  reasoning: string;
  confidence?: number;
}

export interface ActionAdvisor {
  readonly name: string;
  /**
   * Pick one candidate. Return `null` for soft failures (timeout, rate
   * limit, malformed response) — the crawler will fall back to its
   * heuristic. Hard failures (auth, network down) may throw; the crawler
   * catches and degrades.
   */
  suggest(ctx: AdvisorContext): Promise<AdvisorSuggestion | null>;
}

export interface AdvisorConfig {
  /** Required to enable. Default: undefined (advisor disabled). */
  provider: ActionAdvisor;
  /** Hard cap on advisor calls per crawl. Default: 20. */
  maxCallsPerCrawl?: number;
  /** Hard cap per page. Default: 3. */
  maxCallsPerPage?: number;
  /** Consult after this many consecutive zero-novelty actions. Default: 5. */
  noveltyStallThreshold?: number;
  /** Also consult on invariant violation. Default: true. */
  consultOnInvariantViolation?: boolean;
  /** Per-call timeout in ms. Default: 8000. After timeout the call returns null. */
  timeoutMs?: number;
  /** Skip advisor when fewer than N candidates. Default: 3. */
  minCandidatesToConsult?: number;
  /**
   * When true, the model's `reasoning` string is replaced with "[redacted]"
   * before being written to `CrawlReport.advisor.picks[].reasoning` and to
   * the trace's advisor stamp. The provider still sees the raw reasoning
   * at call time — redaction happens at the storage boundary. Use on
   * internal apps where UI text in the reasoning could be sensitive.
   * Default: false.
   */
  redactReasoning?: boolean;
  /**
   * Screenshot mode for advisor consults. `viewport` (default) sends only
   * what the user currently sees — smaller payload, lower cost, but the
   * model can miss off-screen UI. `fullPage` captures the entire scrollable
   * page — better signal for long pages but 2-5× the bytes / tokens.
   * Default: "viewport".
   */
  screenshotMode?: "viewport" | "fullPage";
}

export const REDACTED_REASONING = "[redacted]";
