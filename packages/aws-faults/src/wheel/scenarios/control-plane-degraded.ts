/**
 * Scenario: "control-plane degraded — STS hot-path dependency"
 *
 * Wraps the 2021-12-07 us-east-1 replay. The agent gets a generic
 * latency / success-rate alert that mentions auth/console issues —
 * vague control-plane symptoms. The actual root cause is that the
 * target makes a synchronous STS GetCallerIdentity on every customer
 * request as a "multi-tenant tier check," so STS throttling kills
 * /orders directly.
 *
 * The 2021 lesson, in one sentence: control-plane calls (STS, IAM,
 * EC2 control plane, Route53 management) are usually invisible
 * dependencies — they happen via the SDK credential provider chain
 * or in middleware — and they fail in distinctive ways during a
 * control-plane outage. Apps with hot-path control-plane calls
 * (intentional or not) have the worst outcomes.
 *
 * What good agents do:
 *   - Notice chaos stats: sts-peak firing at 70%, ec2 latency, etc.
 *   - Read target source: find the STS call on the customer path
 *   - Decide: do we really need this? (Often: no — remove.)
 *           If yes: cache (TTL'd in-memory) or move off the hot path.
 *
 * What bad agents do:
 *   - Try to fix STS (can't; it's "AWS")
 *   - Add retries on STS (makes it worse; STS doesn't have feedback in
 *     our model but the per-request latency stacks)
 *   - Decouple Kinesis or S3 (irrelevant; those aren't the bottleneck)
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
import { aws_2021_12_07_useast1 } from "../../drills/incidents/aws-2021-12-07-useast1.ts";

export interface ControlPlaneDegradedOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function controlPlaneDegraded(opts: ControlPlaneDegradedOptions): Scenario {
  const drill = aws_2021_12_07_useast1({
    probeUrl: opts.probeUrl,
    durationMs: opts.durationMs ?? 90_000,
  });

  return {
    id: "control-plane-degraded",
    chaosModelVersion: "fixed-v1",
    title: "Console login broken, OrderService p95 spiking",
    initialAlert:
      "[P1] OrderService: success rate dropped to 60%, p95 latency climbing through 3s. " +
      "Ops team also reports AWS Console login failing intermittently. " +
      "No recent deploy. On-call paged.",
    drill,
    groundTruth:
      "AWS STS in us-east-1 is throttling (70% ThrottlingException) and EC2 control-plane " +
      "calls are slow. The target makes a synchronous STS GetCallerIdentity on every " +
      "customer request (a 'tenant tier check' added during a feature-flag rollout). " +
      "That's the customer impact. The console-login mention is a real cascade — also " +
      "depends on STS — but is not affecting this app per se. Mitigation choices: " +
      "remove the STS call (best — gratuitous), cache the identity (TTL'd in-memory), " +
      "or move it off the hot path (background refresh).",
    pages: [
      {
        atSec: 18,
        severity: "warn",
        text: "AWS Console: 'sign-in service is experiencing elevated error rates.'",
      },
      {
        atSec: 32,
        severity: "info",
        text: "AWS Health Dashboard: 'increased error rates and latencies in US-EAST-1 for STS / EC2 / Route53 control plane.'",
      },
      {
        atSec: 55,
        severity: "warn",
        text:
          "Internal monitoring: AssumeRole calls failing across the platform team's services. " +
          "Some pods can't refresh credentials and are getting 403 on next AWS call.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Tried to fix EC2 instances / Route53 records / IAM roles",
        matchKeyword: "(restart|fix|recreate|recreate).*(ec2|route53|iam\\s+role|policy)",
      },
      {
        hypothesis: "Added retries on STS (deepens the control-plane load)",
        matchKeyword: "(retry|maxAttempts|attempts).*sts|sts.*(retry|maxAttempts|attempts)",
      },
      {
        hypothesis: "Decouple Kinesis / S3 (irrelevant — those aren't the bottleneck)",
        matchKeyword: "(decouple|fire[\\s-]*and[\\s-]*forget|async).*(kinesis|s3|receipt|audit)",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — see sts-peak matched at high rate",
      "Read target source — find STS GetCallerIdentity on the order path",
      "Hypothesize: STS chaos kills the hot-path call; the console / AssumeRole " +
        "alerts are cascade noise from other services that also depend on STS",
      "Mitigate: remove the gratuitous STS call OR cache it OR async it",
      "Verify /orders sustained above the threshold",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3), // weight 3 — must read source to find the hot-path STS
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
