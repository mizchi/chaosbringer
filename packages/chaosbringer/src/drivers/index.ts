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
export {
  boundaryValueProvider,
  defaultValueProvider,
  fromList,
  type FieldValueProvider,
  type FormFieldInfo,
} from "./field-values.js";
export { formDriver, type FormDriverOptions } from "./form-driver.js";
export { payloadDriver, type PayloadDriverOptions } from "./payload-driver.js";
export {
  combinePayloadSets,
  DEFAULT_PAYLOAD_SETS,
  HTML_INJECTION_PAYLOADS,
  LARGE_PAYLOADS,
  PATH_TRAVERSAL_PAYLOADS,
  SQLI_PAYLOADS,
  TEMPLATE_INJECTION_PAYLOADS,
  UNICODE_PAYLOADS,
  XSS_PAYLOADS,
  type PayloadSetName,
} from "./payloads.js";
export { flowDriver, type FlowDriverOptions, type FlowStep } from "./flow-driver.js";
export {
  authAttackDriver,
  detectAuthForm,
  freshTestEmail,
  NONEXISTENT_USERNAME,
  SQL_ERROR_SIGNATURES,
  SQLI_AUTH_BYPASS_PAYLOADS,
  WEAK_PASSWORDS,
  XSS_AUTH_MARKER,
  XSS_CREDENTIAL_PAYLOADS,
  type AuthAttackDriver,
  type AuthAttackName,
  type AuthAttackOptions,
  type AuthFinding,
  type AuthFindingSeverity,
  type AuthFormType,
  type DetectedAuthForm,
} from "./auth-attack/index.js";
