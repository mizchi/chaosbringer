export { silentCreditCardFailures } from "./silent-credit-card-failures.ts";
export type { SilentCreditCardFailuresOptions } from "./silent-credit-card-failures.ts";

export { morningRushCognito } from "./morning-rush-cognito.ts";
export type { MorningRushCognitoOptions } from "./morning-rush-cognito.ts";

export { checkoutReceiptsStalled } from "./checkout-receipts-stalled.ts";
export type { CheckoutReceiptsStalledOptions } from "./checkout-receipts-stalled.ts";

export { ddbThrottleWarmup } from "./ddb-throttle-warmup.ts";
export type { DDBThrottleWarmupOptions } from "./ddb-throttle-warmup.ts";

export { misleadingChaos } from "./misleading-chaos.ts";
export type { MisleadingChaosOptions } from "./misleading-chaos.ts";

export { controlPlaneDegraded } from "./control-plane-degraded.ts";
export type { ControlPlaneDegradedOptions } from "./control-plane-degraded.ts";

import type { Scenario } from "../types.ts";

export interface ScenarioFactoryOpts {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}
export type ScenarioFactory = (opts: ScenarioFactoryOpts) => Scenario;

// Re-import for the catalog (avoids circular).
import { silentCreditCardFailures } from "./silent-credit-card-failures.ts";
import { morningRushCognito } from "./morning-rush-cognito.ts";
import { checkoutReceiptsStalled } from "./checkout-receipts-stalled.ts";
import { ddbThrottleWarmup } from "./ddb-throttle-warmup.ts";
import { misleadingChaos } from "./misleading-chaos.ts";
import { controlPlaneDegraded } from "./control-plane-degraded.ts";

/**
 * Catalog of all built-in scenarios. Order intentional: easiest first.
 * `pickScenario()` spins the wheel.
 */
export const catalog: { id: string; factory: ScenarioFactory }[] = [
  { id: "ddb-throttle-warmup", factory: ddbThrottleWarmup },
  { id: "silent-credit-card-failures", factory: silentCreditCardFailures },
  { id: "morning-rush-cognito", factory: morningRushCognito },
  { id: "checkout-receipts-stalled", factory: checkoutReceiptsStalled },
  { id: "misleading-chaos", factory: misleadingChaos },
  { id: "control-plane-degraded", factory: controlPlaneDegraded },
];

/**
 * pickScenario randomly selects a scenario factory. The seed lets a test
 * loop reproduce the wheel-spin sequence; omitting it uses Math.random.
 */
export function pickScenario(seed?: number): ScenarioFactory {
  const idx =
    seed === undefined
      ? Math.floor(Math.random() * catalog.length)
      : Math.abs(seed) % catalog.length;
  return catalog[idx]!.factory;
}
