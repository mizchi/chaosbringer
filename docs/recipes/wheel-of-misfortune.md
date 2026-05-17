# Wheel of Misfortune for AI on-call

Adaptation of Google's [Wheel of Misfortune](https://sre.google/workbook/training-site-reliability-engineers/#disaster-role-playing)
training format, applied to an AI agent instead of a human SRE.

## What WoM is

In Google SRE's WoM, a facilitator picks a scenario from a wheel of past
incidents. The on-call trainee receives a vague initial page and must work
through diagnosis and mitigation. The facilitator role-plays the system —
when the trainee says "I'd run X", the facilitator describes what X would
return. The session ends with a debrief comparing the trainee's path
against an "ideal" path the scenario author wrote ahead of time.

Two design choices in WoM matter most for adapting it to AI:

1. **Process over outcome.** A trainee who got lucky is scored worse than
   one who methodically diagnosed and applied a known runbook step. The
   rubric measures whether the trainee looked at telemetry before acting,
   formed a hypothesis, communicated, and rolled back broken changes.
2. **Vague initial alert.** Real PagerDuty pages say "SUCCESS_RATE drop on
   PaymentService," not "DynamoDB is throttling." The trainee has to do
   their own service-graph traversal. Scenarios with the answer baked into
   the brief teach nothing.

## What this adaptation changes

We have a real, broken system (patched kumo + a deliberately-fragile
target app), so we don't need a facilitator to role-play the system —
the agent's actions hit reality. What we DO need:

| WoM concept | Our implementation |
|---|---|
| Wheel-spin scenario selection | `pickScenario()` selects from `scenarios.catalog` |
| Vague initial page | `Scenario.initialAlert` — no AWS service named unless customer-facing |
| Hidden ground truth | `Scenario.groundTruth` — shown only in the debrief |
| Mid-incident pages | `Scenario.pages[]` — append to `/tmp/.../oncall-pages.txt` on schedule |
| Red herrings the trainee may chase | `Scenario.redHerrings[]` — regex-detected in transcript |
| Ideal path | `Scenario.idealPath[]` — printed in debrief |
| Rubric | `Scenario.rubric[]` — process-over-outcome criteria |
| Debrief | `scenario.debrief` — auto-generated Markdown |

## Anatomy of a scenario

```ts
import type { Scenario } from "@mizchi/aws-faults/wheel";
import { aws_2015_09_20_dynamodb } from "@mizchi/aws-faults/drills";
import {
  checkedKumoChaosStats,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "@mizchi/aws-faults/wheel";

export function silentCreditCardFailures(opts: { probeUrl: string }): Scenario {
  return {
    id: "silent-credit-card-failures",
    title: "Credit card authorization rate dropping",
    // VAGUE. No mention of DDB. This is what the on-call sees first.
    initialAlert:
      "[P1] PaymentService: success rate dropped from 99.7% to 56% over the last 4 minutes. " +
      "On-call paged. SLO breach in 10 minutes. Recent deploy 12 minutes ago.",
    drill: aws_2015_09_20_dynamodb({ probeUrl: opts.probeUrl }),
    // Revealed in debrief only.
    groundTruth:
      "DDB metadata service is overloaded; PutItem on orders table throttling at ~55%. " +
      "The 'recent deploy' is unrelated. SQS and CloudWatch errors are cascaded symptoms.",
    pages: [
      { atSec: 12, severity: "warn", text: "Datadog: CloudWatch PutMetricData p99 80ms -> 1.4s" },
      { atSec: 25, severity: "warn", text: "SQS DLQ depth orders-failed: 12 -> 340 in 3 minutes" },
      { atSec: 45, severity: "info", text: "Customer support: 17 tickets in 5 minutes" },
    ],
    redHerrings: [
      { hypothesis: "Blamed the recent deploy", matchKeyword: "(recent\\s+deploy|roll\\s*back)" },
      { hypothesis: "Blamed CloudWatch", matchKeyword: "cloudwatch.*(slow|latency)" },
    ],
    idealPath: [
      "Read pageboard + target source",
      "Hit /kumo/chaos/stats — see ddb throttle firing at ~55%",
      "Hypothesize: DDB upstream, others cascaded",
      "Apply minimal fix (cap retries OR circuit breaker)",
      "Verify probe SLO recovers",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
      didNotAddRetries(3),        // the 2015 anti-pattern
      minimalCodeChange(3, 2),
      recoveredSlo(5),
    ],
  };
}
```

## Running the wheel

```sh
ANTHROPIC_API_KEY=… pnpm -F aws-chaos-rehearsal-example wheel
# spin once, scenario picked at random

SCENARIO=morning-rush-cognito pnpm -F aws-chaos-rehearsal-example wheel
# force a specific scenario
```

Per-run artifacts land in a temp dir, printed at startup:

```
wom-XXXX/
├── oncall-pages.txt   # the page board the agent watches
├── transcript.txt     # everything the agent said
├── tool-uses.jsonl    # every tool call, with timestamps
├── debrief.md         # auto-generated post-mortem of the agent's run
└── report.json        # structured rubric scores
```

`debrief.md` is the artifact you put on a slide. Example:

```md
# Debrief: Credit card authorization rate dropping

**Outcome:** RECOVERED
**Score:** 75%

## Ground truth
DDB metadata service is overloaded; PutItem on orders table throttling at ~55%. ...

## Ideal investigation path
- Read pageboard + target source
- Hit /kumo/chaos/stats — see ddb throttle firing at ~55%
- ...

## Rubric
- **[PASS]** Inspected logs / source / metrics before editing any code (weight 3)
- **[PASS]** Queried kumo /kumo/chaos/stats... (weight 2)
- **[FAIL]** Did not increase SDK retry attempts (weight 3)
    - Added more retries. This makes retry-storm-driven outages worse.
- **[PASS]** Probe SLO returned to acceptance criteria (weight 5)

## Red herrings followed
- Blamed CloudWatch latency

## Phase-by-phase SLO
- onset-metadata-storm: 8/10 OK (80%)
- peak-55pct-errors: 2/30 OK (7%)
- metadata-paused-recovering: 14/24 OK (58%)
- tail-autoscaling-backlog: 36/40 OK (90%)
- recovery: 18/20 OK
```

## Writing new scenarios

A scenario is a small descriptor file — under 50 lines of code. Keep these
properties:

1. **Initial alert MUST NOT name the upstream service.** If it does, you're
   testing whether the agent can read a brief, not whether it can diagnose.
2. **Ground truth is for the debrief, not the agent.** The agent should be
   able to discover it through telemetry / source / `/kumo/chaos/stats`.
3. **Each red herring should be a plausible wrong hypothesis** an
   experienced on-call would consider for at least a moment. "It's DNS"
   is a fine red herring; "it's the moon's gravity" is not.
4. **Rubric criteria should be process-focused.** Outcome ("did SLO
   recover") is worth 5 points; process criteria together should outweigh
   it 2-3x, so a passing outcome via a chaotic process scores below a
   failing outcome reached methodically.

## When NOT to use scenarios

If you're testing whether a specific fault breaks your app — use a `Drill`
directly. Scenarios add overhead (page scheduling, scoring, debrief) that's
wasted when you don't care about the agent's process.

If you're testing the agent at a much smaller scale (e.g. is it capable of
recognizing throttling?) — use a unit test of the rubric primitives against
a fixture transcript. The whole wheel is overkill for that.

Scenarios shine when the question is "**how does a competent on-call agent
behave under a specific failure shape?**" — which is exactly the question
Google's original WoM was built to answer.
