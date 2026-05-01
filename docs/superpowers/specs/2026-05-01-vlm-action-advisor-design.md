# VLM action advisor — Design

**Date:** 2026-05-01
**Project:** chaosbringer
**Status:** Proposal (no implementation in this PR)

**Goal:** Add an optional VLM (vision-language model) advisor that picks the next action from a candidate list when the existing coverage-guided heuristic stalls. The advisor sees a screenshot plus a textual list of candidate actions and returns one index. Default reference provider is OpenRouter `google/gemini-2.5-flash`.

**Non-goal:** Replace the heuristic. The advisor is an opt-in second opinion that the crawler consults rarely (budgeted), not a per-step driver.

**Why now:** `coverageWeightFor` (see `src/crawler.ts:845`) biases toward targets that previously delivered new V8 coverage, but it cannot see *visual* prerequisites — e.g. "the Submit button is disabled until the consent checkbox above it is ticked." A VLM can read those layout cues from a screenshot and break the heuristic out of local maxima.

**Out of scope (this PR):** Implementation, prompt engineering, fixture additions, OpenRouter client, cost telemetry, CI wiring. This PR ships the contract and the integration plan only. Implementation lands in a follow-up PR per the phased plan in §10.

---

## 1. File structure

```
chaosbringer/
├── src/
│   ├── advisor/
│   │   ├── types.ts              # NEW — interface, config, schemas
│   │   ├── openrouter.ts         # NEW — OpenRouter implementation of ActionAdvisor
│   │   ├── advisor.test.ts       # NEW — unit tests for trigger policy + budget
│   │   └── prompts/
│   │       └── action-selection.md  # NEW — system + user prompt template (file, not string literal)
│   ├── crawler.ts                # MODIFY — call advisor when shouldConsultAdvisor() is true
│   └── types.ts                  # MODIFY — extend ChaosCrawlerOptions with `advisor?: AdvisorConfig`
├── docs/
│   └── advisor.md                # NEW — user-facing how-to
└── README.md                     # MODIFY — one-paragraph "Visual advisor (opt-in)" section
```

`advisor/` is a subdirectory rather than a flat `src/<topic>.ts` because the advisor has more than one file (provider impls, prompt asset, schemas) and we want the prompt asset colocated with the code that loads it. This intentionally diverges from the flat convention used elsewhere — see "Layout exception" in §11.

---

## 2. Interface (the contract layer)

```ts
// src/advisor/types.ts

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

export interface AdvisorContext {
  url: string;
  /** PNG bytes, full-page screenshot at the moment of consult. */
  screenshot: Buffer;
  candidates: AdvisorCandidate[];
  /** Why the crawler is asking — drives prompt framing. */
  reason: "novelty_stall" | "invariant_violation" | "explicit_request";
  /** How many advisor calls remain in this crawl, after this one. */
  budgetRemaining: number;
}

export interface AdvisorSuggestion {
  chosenIndex: number;
  reasoning: string;        // 1-3 sentences, kept for trace/debug
  confidence?: number;      // 0..1, optional
}

export interface ActionAdvisor {
  readonly name: string;    // "openrouter/gemini-2.5-flash" etc.
  suggest(ctx: AdvisorContext): Promise<AdvisorSuggestion | null>;
}
```

`suggest` returning `null` means "no opinion, fall back to heuristic". Providers MUST return `null` (not throw) for soft failures: timeout, rate limit, malformed response. Hard failures (auth, network down) are still allowed to throw — the crawler will catch and degrade.

---

## 3. Config

Extends `ChaosCrawlerOptions`:

```ts
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

  /** Skip advisor when fewer than N candidates — heuristic is fine. Default: 3. */
  minCandidatesToConsult?: number;
}
```

Why the caps and not a "rate limit" abstraction:
- Single-process crawl, single user — token-bucket is overkill.
- Per-crawl + per-page caps make budget reasoning trivial in CI: `maxCallsPerCrawl * pricePerCall = upper bound`.

`AdvisorConfig` is intentionally not loaded from `chaosbringer.config.ts` directly — the provider is a constructed object with secrets baked in. Users pass it in code:

```ts
import { ChaosCrawler } from "chaosbringer";
import { openRouterAdvisor } from "chaosbringer/advisor";

const crawler = new ChaosCrawler({
  url: "...",
  advisor: {
    provider: openRouterAdvisor({
      apiKey: process.env.OPENROUTER_API_KEY!,
      model: "google/gemini-2.5-flash",
    }),
    maxCallsPerCrawl: 20,
  },
});
```

---

## 4. Trigger policy (where it plugs into the loop)

The integration point is `performWeightedActions` at `src/crawler.ts:1665`. Today's loop:

```ts
const selectedTarget = weightedPick(
  targets,
  (t) => t.weight * this.coverageWeightFor(url, t.selector),
  this.rng,
);
```

The proposed loop:

```ts
const selectedTarget =
  (await this.consultAdvisorIfStalled(page, url, targets)) ??
  weightedPick(
    targets,
    (t) => t.weight * this.coverageWeightFor(url, t.selector),
    this.rng,
  );
```

`consultAdvisorIfStalled` returns `null` when:
- advisor not configured, OR
- budget exhausted (per-crawl or per-page), OR
- candidate count `< minCandidatesToConsult`, OR
- stall counters not yet at threshold AND no invariant violation pending, OR
- `provider.suggest` returned `null` (soft failure).

When it returns a target, that target is used directly — coverage weighting is bypassed for that one pick. Stall counter resets on any non-zero-novelty action OR on a successful advisor pick (so the advisor is consulted at most once per stall).

---

## 5. Determinism & reproducibility

VLM output is non-deterministic by nature. The crawler's existing `seed` reproducibility guarantee covers heuristic picks; advisor picks are explicitly outside that guarantee.

Mitigations:
1. **Trace recording.** When the advisor is consulted, record the chosen `selector`, `reasoning`, and the screenshot hash into the trace (`src/crawler.ts` `actionToTraceEntry` extension). Re-running from a trace replays the recorded selector instead of consulting again — replays stay deterministic.
2. **Disabled by default in CI.** The `chaos-baseline.yml` workflow does NOT enable the advisor. Baseline crawls remain deterministic and cheap.
3. **Reproduction command excludes advisor.** When `failure-artifacts.ts` writes the repro command for a failure, it omits the advisor config. The repro reaches the failing URL via the recorded action trace, not by re-consulting the model.

---

## 6. Provider contract — OpenRouter / Gemini Flash 2.5

```ts
// src/advisor/openrouter.ts

export interface OpenRouterAdvisorOptions {
  apiKey: string;
  model?: string;                 // default "google/gemini-2.5-flash"
  baseUrl?: string;               // default "https://openrouter.ai/api/v1"
  /** Optional HTTP client override for tests. */
  fetch?: typeof globalThis.fetch;
  /** Cost ceiling in USD per crawl. After this the advisor returns null. */
  budgetUsd?: number;
}

export function openRouterAdvisor(opts: OpenRouterAdvisorOptions): ActionAdvisor;
```

Wire format: OpenAI-compatible chat completions with `messages: [{ role: "system", ... }, { role: "user", content: [{type:"text"}, {type:"image_url", image_url: {url: "data:image/png;base64,..."}}] }]`. OpenRouter normalizes this for Gemini.

Response parsing: extract the assistant text, JSON-parse it, validate against `AdvisorSuggestionSchema` (zod). On parse failure, return `null` (soft failure — never throw on bad model output).

Cost accounting: OpenRouter returns `usage` in the response. Track cumulative USD via the `x-openrouter-cost` header or computed from token counts. When `budgetUsd` is exceeded, subsequent calls return `null` immediately without hitting the network.

**Secret handling:** `apiKey` only ever lives in the constructed advisor object. It is never logged, never traced, never written to the repro command. The trace records `provider.name` only.

---

## 7. Prompt asset

`src/advisor/prompts/action-selection.md` is a markdown file with two sections delimited by `---SYSTEM---` and `---USER---`. The user-template uses `{{candidates}}`, `{{url}}`, `{{reason}}` placeholders filled at call time.

Why a file, not a string in code:
- Diff-friendly when iterating on prompt wording.
- Testable independently (snapshot test on rendered prompt).
- Matches the project guidance "静的検査可能なルールはプロンプトではなく…linter か ast-grep" — keep behavioral knobs in assets, not literals scattered in `.ts`.

Initial prompt sketch (final wording in the implementation PR):

```
---SYSTEM---
You are an exploratory web testing agent. Given a screenshot and a list of
candidate UI elements, pick the ONE element most likely to reveal previously
unexplored application state. Prefer interactive elements that look enabled
and visually prominent over decorative or disabled ones. Respond with JSON
only: {"chosenIndex": <number>, "reasoning": "<1-3 sentences>"}.

---USER---
URL: {{url}}
Reason for asking: {{reason}}
Candidates:
{{candidates}}
```

---

## 8. Observability

Every consult emits one log event:

```ts
this.logger.debug("advisor_consult", {
  reason,
  candidateCount,
  budgetRemaining,
  durationMs,
  chosenIndex,           // null if soft-failed
  provider: provider.name,
  costUsd,               // optional, when provider exposes it
});
```

`CrawlReport` gains a top-level `advisor` block:

```ts
advisor?: {
  provider: string;
  callsAttempted: number;
  callsSucceeded: number;
  totalCostUsd?: number;
  picks: Array<{
    url: string;
    reason: AdvisorContext["reason"];
    chosenSelector: string;
    reasoning: string;
  }>;
};
```

This block flows through to the flaker chaosbringer adapter as `variant.advisor = "<provider-name>"` so flaker storage can split rows by "advised vs not."

---

## 9. Tests

`src/advisor/advisor.test.ts` (unit, no network):

1. Trigger policy — stall counter reaches threshold ⇒ consult; below threshold ⇒ no consult.
2. Budget — `maxCallsPerCrawl` exhausted ⇒ subsequent calls return null without invoking the provider.
3. Per-page cap — separate from per-crawl cap.
4. Provider returns null ⇒ heuristic fallback used; trace records "advisor_skipped".
5. Provider throws ⇒ caught, logged at warn, fallback used; crawl does not abort.
6. `chosenIndex` out of range ⇒ rejected, fallback used.
7. Schema validation rejects extra fields silently (forward-compat for new model fields).

A separate fixture-only e2e test (`tests/e2e/advisor.test.ts`, gated behind `OPENROUTER_API_KEY`) drives a real call against the existing `/spa-router` fixture page and asserts the advisor picks one of the three pushState buttons. Skipped in CI by default; run locally with `pnpm test:e2e:advisor`.

---

## 10. Implementation phases (PR sequence)

This design PR is **PR #N (this one)**. Implementation lands across 3 follow-up PRs to keep diffs small and revertable:

| PR | Title | Scope | Dependencies |
|----|-------|-------|--------------|
| #N+1 | feat: ActionAdvisor interface + budget plumbing | `src/advisor/types.ts`, advisor option in `ChaosCrawlerOptions`, stall counter in crawler, no-op when unconfigured. Unit tests for trigger policy. | this design PR |
| #N+2 | feat: OpenRouter Gemini Flash 2.5 advisor provider | `src/advisor/openrouter.ts`, prompt asset, zod schemas, snapshot test on rendered prompt. | #N+1 |
| #N+3 | feat: trace + report integration for advisor picks | `CrawlReport.advisor` block, replay path uses recorded selector, flaker adapter passes `variant.advisor`. | #N+2 |

Each follow-up PR is independently mergeable and revertable. After #N+1 merges, the advisor is dormant code — no behavior change. After #N+2, it can be enabled by user code. After #N+3, full observability.

---

## 11. Layout exception (and why)

The convention noted in the server-side fault injection design (`docs/superpowers/specs/2026-04-30-server-side-fault-injection-design.md` §1) is flat `src/<topic>.ts`. The advisor breaks this with `src/advisor/`. The reason:

- Multiple provider implementations expected (OpenRouter today, Anthropic vision later, local model someday).
- Prompt asset must be colocated with the loader for build-time discovery.
- Tests are easier to read when grouped under the same directory as the impl they cover.

If a future provider PR adds, say, `src/advisor/anthropic.ts`, the flat convention would have produced `src/advisor-anthropic.ts` — an awkward name that pretends to be flat but is really namespaced. Better to admit the namespace.

---

## 12. Risks & open questions

- **Cost surprise.** Even at $0.005/call × 20 calls × 100 crawls/day = $10/day. Budget UI in `CrawlReport` makes this visible but does not prevent it. Open question: should the CLI print a "cost summary" footer when advisor was used?
- **Screenshot size.** Full-page screenshots on a long page can be 1-3 MB PNG. Gemini Flash accepts large images but they cost more tokens. Open question: viewport-only screenshot (and let the crawler scroll between consults), or full-page?
- **Candidate description quality.** Today `ActionTarget` only has `selector`, `role`, `name`. The advisor needs more — visible text, parent context, disabled state. The implementation PR will need to extend `getWeightedActionTargets` to capture richer descriptions. This may slow down target discovery; benchmark in #N+1.
- **Reasoning leakage.** The `reasoning` string the model returns is stored in traces and reports. If users feed the advisor on internal apps, the reasoning may include UI text that's confidential. Document this in `docs/advisor.md` and add a `redactReasoning?: boolean` config flag in #N+3.
- **Replay fidelity.** When replaying a trace that was recorded with the advisor, the recorded selector may no longer exist (UI changed). Today's heuristic-driven replay has the same problem; advisor-driven replay just makes it more visible. No new mitigation in this design — flagged for tracking.

---

## 13. Decision log

- **Why advisor, not driver.** Driver (= every step) is 100-1000× too expensive. Advisor (= only when stuck) preserves the deterministic heuristic and pays the LLM cost only where it earns its keep.
- **Why OpenRouter, not direct Gemini.** OpenRouter gives provider portability with one API surface and no GCP setup. Switching to direct Gemini, Anthropic, or a local model later only changes the provider impl, not the interface.
- **Why Gemini Flash 2.5 as default.** Cheap (≈ $0.0005-0.002 per call at typical screenshot+prompt sizes), fast (1-3s p50), competent at "pick one of N from this image" tasks per public eval coverage. Sonnet/Opus would be better but break the budget reasoning.
- **Why opt-in (default off).** Advisor adds non-determinism and cost. Both are user choices, not defaults. CI baseline workflows must be reproducible without secrets.
