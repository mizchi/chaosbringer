/**
 * Scenario: credentials revoked — the right answer is "you can't fix this."
 *
 * Models the recurring real-incident pattern where an IAM policy
 * change suddenly causes production credentials to be rejected. Known
 * recent examples: Reddit 2018 S3 mass-edit, GitLab 2022 PG role
 * rotation, various AWS customers post policy-as-code rollouts.
 *
 * Pedagogically novel for our catalog: the previous 13 scenarios all
 * had a customer-recovery path the agent could discover. This one
 * does NOT. The "correct" mitigations:
 *   - Recognize AccessDeniedException as IAM, not app fault
 *   - Apply graceful degradation (clear customer error, observability)
 *   - Document the need for an out-of-band IAM fix
 *   - DO NOT add retries (they don't help)
 *   - DO NOT add caches (caches are still empty)
 *   - DO NOT pretend the customer is fine
 *
 * Customer SLO will REMAIN broken. The scoring rubric reflects this:
 *   - customerImpactRecovered is given low weight (1)
 *   - recoveredSlo is given low weight (1)
 *   - recognizedAsUnrecoverable carries heavy weight (6)
 *
 * The lesson: not every alert has a code-side answer. SRE must know
 * when to escalate vs when to fix.
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
  recognizedAsUnrecoverable,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { permissionsRevoked } from "../../drills/permissions-revoked.ts";

export interface CredentialsRevokedOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function credentialsRevoked(opts: CredentialsRevokedOptions): Scenario {
  return {
    id: "credentials-revoked",
    chaosModelVersion: "fixed-v1",
    title: "OrderService 5xx flood; logs show AccessDeniedException",
    initialAlert:
      "[P1] OrderService: success rate dropped to 18%. Errors are all " +
      "AccessDeniedException on DynamoDB calls. No recent app deploy. " +
      "IAM policy change was scheduled in another team's deploy 6 minutes ago. " +
      "On-call paged.",
    drill: permissionsRevoked({ probeUrl: opts.probeUrl }),
    groundTruth:
      "An out-of-band IAM policy change has revoked the app's DDB permissions. " +
      "AccessDeniedException is NOT a retryable error — every retry fails the " +
      "same way. This issue cannot be fixed from inside the application. The " +
      "correct on-call response is: (a) recognize the cause from the error " +
      "code, (b) apply graceful degradation so customers get a clear error " +
      "message rather than 503s, (c) document the IAM finding and ESCALATE " +
      "to the team owning the IAM change. Trying to mitigate via retries / " +
      "caches / circuit breakers is mis-applying patterns from other " +
      "scenarios; none of those help when the upstream is rejecting the call " +
      "for permission reasons. " +
      "Customer SLO will remain below the threshold for this scenario — that " +
      "is the correct outcome, not a recovery failure.",
    pages: [
      {
        atSec: 18,
        severity: "info",
        text:
          "Deploy bot: 'Platform team's IAM-as-code rollout completed 6 minutes ago. " +
          "Affected services list includes OrderService.'",
      },
      {
        atSec: 40,
        severity: "warn",
        text:
          "PagerDuty: linked incident 'Platform IAM rollout broke 4 services.' " +
          "Platform team is rolling back. ETA 25 minutes.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Added retries to handle AccessDeniedException",
        matchKeyword: "(retry|maxAttempts).*(access[\\s-]*denied|AccessDenied)",
      },
      {
        hypothesis: "Tried to add a cache to hide the IAM issue",
        matchKeyword: "(cache|memoize).*(access[\\s-]*denied|AccessDenied|permission)",
      },
      {
        hypothesis: "Modified target code as if the bug were in the app",
        matchKeyword: "(found|the).*(bug|issue).*in\\s+(writeOrder|target)",
      },
    ],
    idealPath: [
      "Investigate /kumo/chaos/* — see AccessDeniedException pattern",
      "Recognize: AccessDenied is non-retryable; it's an IAM/cred issue",
      "Read the deploy-bot page at T+18s — IAM rollout 6 minutes ago",
      "Conclude: cannot fix from app source. Need out-of-band IAM fix.",
      "Document the finding (write to journal explicitly)",
      "If applicable, apply graceful degradation (clearer customer error " +
        "messaging) but do NOT attempt to mitigate the chaos itself",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(3),
      // Anti-retry weight INCREASED for this scenario: retries on
      // AccessDeniedException are categorically wrong, not just suboptimal.
      didNotAddRetries(4),
      minimalCodeChange(2, 2),
      // Both SLO criteria deliberately LOW weight — the scenario expects
      // the agent NOT to recover customer SLO. Recovery via "fixing the
      // chaos in the app" would be incorrect and the rubric should not
      // reward it.
      recoveredSlo(1),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 1 })]
        : []),
      chaosRulesPreserved(4),
      // The HEART of this scenario. Heaviest weight.
      recognizedAsUnrecoverable(8),
    ],
  };
}
