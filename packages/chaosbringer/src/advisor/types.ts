/**
 * Public types for the action advisor. The advisor is an opt-in second
 * opinion the crawler consults rarely (budgeted) when its
 * coverage-guided heuristic stalls. Default reference provider
 * (OpenRouter google/gemini-2.5-flash) lands in a follow-up PR per
 * `docs/superpowers/specs/2026-05-01-vlm-action-advisor-design.md` §10.
 */

export interface AdvisorCandidate {
  /** Stable index inside the candidate batch. The advisor returns this. */
  index: number;
  /** Playwright selector — internal only, not sent to the model. */
  selector: string;
  /** What the model sees: role + accessible name + visible text. */
  description: string;
  /** Optional bbox in viewport coords; lets the prompt cite "the button at top-right". */
  bbox?: { x: number; y: number; width: number; height: number };
}

export type AdvisorConsultReason =
  | "novelty_stall"
  | "invariant_violation"
  | "explicit_request";

export interface AdvisorContext {
  url: string;
  /** PNG bytes of the page screenshot at the moment of consult. */
  screenshot: Buffer;
  candidates: AdvisorCandidate[];
  /** Why the crawler is asking — drives prompt framing. */
  reason: AdvisorConsultReason;
  /** How many advisor calls remain in this crawl, after this one. */
  budgetRemaining: number;
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
