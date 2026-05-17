# Eval pass: control-plane-degraded (6th scenario, 2021 us-east-1 replay)

Closes the last gap in the scenario catalog. Every incident drill now
has a scenario wrapper.

## Setup

Added `@aws-sdk/client-sts` to target. `target/src/server.fragile.ts`
calls STS `GetCallerIdentity` synchronously at the start of
`writeOrder()` — framed as a "tenant tier check" for a feature-flag
rollout. The source comment explicitly names this as the 2021
anti-pattern.

The 2021 drill's peak phase installs `sts-peak` (70% ThrottlingException)
and `ec2-peak` (latency on DescribeInstances). The CLI installed both;
sts-peak fires hot, ec2-peak stays at matched=0 because the target
makes no EC2 calls (correct cascade behavior — the cascade is a
distraction by design).

Baseline impact under chaos: /orders ~67% (10/15). SDK default
retries absorb some throttling but most surfaces to customers.

## What the agent did

```
T+N  pages:    "p95 3s, 60%, console login failing, no recent deploy"
T+N  chaos:    GET /kumo/chaos/rules + stats — sts-peak at 70%,
               ec2-peak matched=0
T+N  source:   target/src/server.ts → STS GetCallerIdentity at top
               of writeOrder(). Comment explicitly says this is the
               2021 pattern.
T+N  edit:     removed the STS call entirely
T+N  restart:  pkill tsx; nohup npx tsx
T+N  verify:   two consecutive 40/40 bursts on /orders = 80/80 = 100%
T+N  stats:    sts-peak matched=193 — chaos still firing through recovery
```

Wall clock: 62 seconds. Tool uses: 11.

The agent picked the **best** of three documented mitigations (remove
vs cache vs async). "Remove" is best because the call was gratuitous —
the tenant-tier check shouldn't run on every customer request.

## Result

**100% rubric / 100% customer / 0 ground-rule violations.**

| Criterion | Verdict | Weight |
|---|---|---|
| investigatedBeforeEditing | PASS | 3 |
| checkedKumoChaosStats | PASS | 2 |
| readTargetSource | PASS | 3 (bumped from 2 — must read source for this scenario) |
| statedHypothesis | PASS | 2 |
| didNotAddRetries | PASS | 3 |
| minimalCodeChange (≤3) | PASS | 2 |
| recoveredSlo | PASS | 3 |
| customerImpactRecovered | PASS | 5 |
| chaosRulesPreserved | PASS | 4 |

27 / 27 = **100%**.

## Why this run was fast

62 seconds is among the fastest evals in the series. The control-plane
scenario has a clear surgical mitigation: chaos stats + source reading →
immediately points at the STS call → remove it. No parameter-tuning
oscillation like the DDB-feedback scenario.

Pattern across scenarios:

| Scenario | Wall clock | Why |
|---|---|---|
| misleading-chaos | 54-65s | Find-and-remove-bug; one right answer |
| control-plane-degraded | 62s | Find-and-remove-call; one right answer |
| morning-rush-cognito | 89s | Fire-and-forget; one right pattern |
| checkout-receipts-stalled | 120s | WAL pattern; one right structure |
| silent-credit-card-failures | 90-500s | Multi-knob tuning under feedback |
| ddb-throttle-warmup | 200-310s | Multi-knob tuning, no feedback signal |

**Time-to-recovery correlates with the cardinality of the correct
mitigation.** Scenarios with one canonical fix produce fast,
high-scoring runs. Scenarios where multiple knobs need tuning
(retries × timeouts × concurrency × backoff) produce slower runs
with higher variance.

## Scenario catalog after this batch

| Scenario | Drill | Lesson | Best-of-N score |
|---|---|---|---|
| ddb-throttle-warmup | (simple DDB) | calibration | 80% |
| silent-credit-card-failures | 2015 DDB + feedback | retry storms amplify | 100% |
| morning-rush-cognito | 2020 Kinesis | hidden buffered upstream | 100% |
| checkout-receipts-stalled | 2017 S3 | durability preservation | 100% |
| misleading-chaos | distraction | chaos isn't always the cause | 100% |
| **control-plane-degraded** | **2021 us-east-1** | **control-plane hot-path dependency** | **100%** |

Six scenarios. Five real-incident lessons (2015 / 2017 / 2020 / 2021 +
warmup) plus one adversarial. The catalog now covers the four big
us-east-1 incidents AWS published post-mortems for, plus the
"chaos isn't the cause" anti-pattern.

## Total runs after this batch

17 subagent runs across 6 scenarios. The 17th run reproduces a clean
real-incident lesson with no rubric brittleness, no escape hatch
attempts, no ground rule violations — the harness is at its mature
state.

## What's next

The drill catalog has now been fully exercised. Future scenario
additions would be:
- Composite scenarios (multiple simultaneous incidents)
- Scenarios with NO chaos (pure target-side bugs, harder adversarial)
- Per-target-language scenarios (Go / Python targets) once the harness
  exports `prepare` as a service instead of a CLI

Statistical work:
- N≥5 multi-shot on each of the 6 scenarios
- Variance comparison across scenario types (one-knob vs multi-knob)
- Cross-agent comparison (Sonnet/Opus/Haiku) once Agent SDK is wired
