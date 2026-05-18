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

export { quotaSaturated } from "./quota-saturated.ts";
export type { QuotaSaturatedOptions } from "./quota-saturated.ts";

export { ddbDnsRace } from "./ddb-dns-race.ts";
export type { DDBDNSRaceOptions } from "./ddb-dns-race.ts";

export { tierLookupStampede } from "./tier-lookup-stampede.ts";
export type { TierLookupStampedeOptions } from "./tier-lookup-stampede.ts";

export { compoundIncident } from "./compound-incident.ts";
export type { CompoundIncidentOptions } from "./compound-incident.ts";

export { restartTrap } from "./restart-trap.ts";
export type { RestartTrapOptions } from "./restart-trap.ts";

export { noHintsStorm } from "./no-hints-storm.ts";
export type { NoHintsStormOptions } from "./no-hints-storm.ts";

export { duplicateOrders } from "./duplicate-orders.ts";
export type { DuplicateOrdersOptions } from "./duplicate-orders.ts";

export { silentDataLoss } from "./silent-data-loss.ts";
export type { SilentDataLossOptions } from "./silent-data-loss.ts";

export { credentialsRevoked } from "./credentials-revoked.ts";
export type { CredentialsRevokedOptions } from "./credentials-revoked.ts";

export { clientTimeoutMisconfig } from "./client-timeout-misconfig.ts";
export type { ClientTimeoutMisconfigOptions } from "./client-timeout-misconfig.ts";

export { multiServiceCascade } from "./multi-service-cascade.ts";
export type { MultiServiceCascadeOptions } from "./multi-service-cascade.ts";

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
import { quotaSaturated } from "./quota-saturated.ts";
import { ddbDnsRace } from "./ddb-dns-race.ts";
import { tierLookupStampede } from "./tier-lookup-stampede.ts";
import { compoundIncident } from "./compound-incident.ts";
import { restartTrap } from "./restart-trap.ts";
import { noHintsStorm } from "./no-hints-storm.ts";
import { duplicateOrders } from "./duplicate-orders.ts";
import { silentDataLoss } from "./silent-data-loss.ts";
import { credentialsRevoked } from "./credentials-revoked.ts";
import { clientTimeoutMisconfig } from "./client-timeout-misconfig.ts";
import { multiServiceCascade } from "./multi-service-cascade.ts";

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
  { id: "quota-saturated", factory: quotaSaturated },
  { id: "ddb-dns-race", factory: ddbDnsRace },
  { id: "tier-lookup-stampede", factory: tierLookupStampede },
  { id: "compound-incident", factory: compoundIncident },
  { id: "restart-trap", factory: restartTrap },
  { id: "no-hints-storm", factory: noHintsStorm },
  { id: "duplicate-orders", factory: duplicateOrders },
  { id: "silent-data-loss", factory: silentDataLoss },
  { id: "credentials-revoked", factory: credentialsRevoked },
  { id: "client-timeout-misconfig", factory: clientTimeoutMisconfig },
  { id: "multi-service-cascade", factory: multiServiceCascade },
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
