/**
 * Scenario: cache stampede on tier-config lookup
 *
 * Wraps `cacheStampede`. Different mitigation shape from the other
 * scenarios: the right fix is to ADD code (an in-memory cache), not
 * to remove or decouple existing code. Tests whether the agent can
 * reach for "add a layer" rather than "shed a layer."
 */
import type { Scenario } from "../types.ts";
import {
  chaosRulesPreserved,
  checkedKumoChaosStats,
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { cacheStampede } from "../../drills/cache-stampede.ts";

export interface TierLookupStampedeOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function tierLookupStampede(opts: TierLookupStampedeOptions): Scenario {
  return {
    id: "tier-lookup-stampede",
    chaosModelVersion: "feedback-v1",
    title: "Tier-config lookups stampeding; DDB GetItem throttled",
    initialAlert:
      "[P1] OrderService: success rate 50%, p95 latency tripled. Errors are " +
      "ProvisionedThroughputExceededException on the tier-config table specifically — " +
      "no other DDB tables affected. On-call paged.",
    drill: cacheStampede({
      probeUrl: opts.probeUrl,
    }),
    groundTruth:
      "Classic cache-stampede shape: every customer request reads the same tier-config " +
      "row from DDB with no local cache. Under load + chaos feedback, the read hot-key " +
      "throttles, and retries amplify. The right mitigation is to ADD an in-memory TTL " +
      "cache for tier-config (read-mostly, low-cardinality — perfect for caching). " +
      "Most other scenarios are fixed by REMOVING a hot-path call or DECOUPLING it. " +
      "This one needs the opposite: add a layer that absorbs reads. The chaos rule " +
      "targets dynamodb:GetItem specifically, not all DDB, so PutItem on orders is " +
      "unaffected — agents who 'cache everything' aren't wrong but agents who only " +
      "cache the read are more focused.",
    pages: [
      {
        atSec: 18,
        severity: "warn",
        text:
          "Datadog: throttle errors localized to GetItem on tier-config table. " +
          "PutItem on orders table is fine. Looks read-side.",
      },
      {
        atSec: 40,
        severity: "info",
        text:
          "Capacity planning: tier-config table is configured with PROVISIONED capacity " +
          "(low RCU because it's tiny). Every customer request reads it. Hot key.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Decoupled the order write (irrelevant — the write isn't throttled)",
        matchKeyword: "(decouple|fire[\\s-]*and[\\s-]*forget|async).*(order|write|PutItem)",
      },
      {
        hypothesis: "Added retries (worsens feedback)",
        matchKeyword: "(maxAttempts|retries).*\\b([5-9]|[1-9]\\d+)\\b",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — note rule targets GetItem only (not all DDB)",
      "Read target source — find getTierConfig DDB call on every request",
      "Recognize: read-mostly, low-cardinality — ideal cache target",
      "Add in-memory TTL cache for tier-config (process-lifetime is fine)",
      "Verify /orders ≥ 80% sustained; tier-config DDB calls now amortized",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      chaosRulesPreserved(4),
    ],
  };
}
