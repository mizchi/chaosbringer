/**
 * Public surface for the driver layer.
 *
 * - `weightedRandomDriver` — the original heuristic action picker.
 * - `aiDriver` — per-step vision-model driver that asks a `DriverProvider`
 *   what to do next.
 * - `compositeDriver` / `samplingDriver` / `probabilityDriver` — combinators
 *   for mixing cheap and expensive drivers.
 * - `advisorFallbackDriver` — the legacy "consult only when stalled" policy
 *   re-expressed on top of the new Driver interface.
 * - `openRouterDriverProvider` / `anthropicDriverProvider` — out-of-the-box
 *   providers wired to the cheap vision tiers of each vendor.
 */
export type {
  Driver,
  DriverCandidate,
  DriverHistoryEntry,
  DriverInvariantViolation,
  DriverPick,
  DriverProvider,
  DriverProviderInput,
  DriverProviderResult,
  DriverStep,
  ScreenshotMode,
} from "./types.js";
export { weightedRandomDriver, type WeightedRandomDriverOptions } from "./weighted-random.js";
export { aiDriver, type AiDriverOptions } from "./ai-driver.js";
export {
  compositeDriver,
  probabilityDriver,
  samplingDriver,
  type CompositeDriverOptions,
  type ProbabilityDriverOptions,
  type SamplingDriverOptions,
} from "./composite.js";
export {
  advisorFallbackDriver,
  type AdvisorFallbackOptions,
  type NoveltySignal,
} from "./advisor-fallback.js";
export { DriverBudget, type DriverBudgetOptions } from "./budget.js";
export {
  openRouterDriverProvider,
  type OpenRouterDriverProviderOptions,
} from "./providers/openrouter.js";
export {
  anthropicDriverProvider,
  type AnthropicDriverProviderOptions,
} from "./providers/anthropic.js";
