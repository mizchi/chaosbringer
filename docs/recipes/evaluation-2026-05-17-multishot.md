# Multi-shot evaluation (2026-05-17): N=3 against ddb-throttle-warmup

First multi-shot run of the harness. Three subagent attempts against the
same scenario (`ddbThrottleWarmup`), same chaos rule (50% throttle on DDB
PutItem, no feedback, no cascade), under the same brief. Driven by the
new `pnpm prepare` / `pnpm score` CLI introduced in this batch.

## Results

| Run | Mitigation | Score | Customer (post-run probe) | Recovered? |
|---|---|---|---|---|
| run1 | `maxAttempts=8` + `retryMode=adaptive` | 23% | 23% | NO |
| run2 | `maxAttempts=8` (plain) | 30% | 60% | NO |
| run3 | `maxAttempts=8` + 6-attempt app retry on ALL services | **80%** | **100%** | YES |

Range: 23-80% score, 23-100% customer success. Mean: 44% score.

## Headline finding — variance is large; N=1 is statistically meaningless

Three runs with structurally similar mitigations produced wildly
different outcomes. Specifically:

- Adaptive retry (run1) **collapses under sustained throttling**. The
  SDK's adaptive token bucket sees a high retry rate and stops
  retrying, surfacing the 50% throttle directly to customers.
  Counterintuitive: a more sophisticated retry mode performs WORSE
  under steady-state chaos than a naive one.
- Plain `maxAttempts=8` (run2) recovers most requests but oscillates.
  60% sustained is below the 80% threshold.
- App-level retry wrapper STACKED on top of SDK retries (run3) gets
  the success rate above the threshold.

This means the difference between "this agent solved it" and "this
agent failed" depends on subtle mitigation details that are hard to
distinguish from the brief alone.

Anyone reporting an eval as N=1 for this scenario could publish 23%,
30%, or 80% as the "agent's performance" depending on which run they
sampled. That is not a measurement.

## Finding 2 — `retryMode=adaptive` is the worst choice here

This was unexpected. The AWS SDK docs describe adaptive retry as the
recommended mode for variable backends. Under our chaos (fixed 50%
throttle, no feedback) it actively degrades behavior because:

1. The adaptive client maintains a per-shape token bucket. When
   `ProvisionedThroughputExceededException` arrives, the bucket
   drains.
2. Once depleted, the client refuses new retries — surfacing the
   throttle to the caller.
3. The bucket only refills slowly. Under sustained chaos it never
   recovers.

Plain `maxAttempts=8` doesn't have this gating, so each request
gets all 8 attempts. Naive but effective here.

This is a real-world lesson the harness exposed accidentally. We
didn't design the scenario to teach "adaptive vs standard retry"
but the multi-shot revealed it.

## Finding 3 — journal-writing discipline accounts for score variance

Run 1 and run 2 both applied retry-only mitigations. The scores
differ (23% vs 30%) primarily because run 1's journal had 3 sparse
entries (no investigation logged), while run 2's journal mentioned
the investigation explicitly. The rubric's
`investigatedBeforeEditing` / `checkedKumoChaosStats` /
`readTargetSource` criteria all check the inferred tool-uses,
which come from the journal text.

The agents DID investigate in both cases (their summaries describe
it), but only the agent that wrote it down got credit.

**Action**: The prepare-CLI prompt should ask the agent to journal
each tool use as it happens, not just at decision points. Already
hinted in the brief ("be thorough"), but run 1 didn't comply.

Or, more robustly: capture actual tool_uses from the Agent harness
rather than inferring from journal text.

## Finding 4 — the customer-impact probe is the most stable signal

Every other criterion is text-based and brittle. The
`customerImpactRecovered` rubric primitive (which probes /orders
directly post-run) gave the cleanest gradient: 23% / 60% / 100%.
That's what an SRE would actually look at first.

Suggests reweighting the rubric: bump customer-impact to weight 7
(was 5) and reduce process-criteria weights when they correlate
strongly with customer impact already.

## Methodology notes

- Same scenario, same chaos config, same brief across all 3 runs
- Subagent type `general-purpose` for all
- Wall clock per run: 3-5 minutes
- prepare CLI reset target + workdir; scored independently
- Live customer probe at score time (30 sequential requests)

## Multi-shot is a usability win

Each run took ~5 minutes of human time (just spawn + wait + score).
The previous manual setup took 5 minutes per run too, but most of
that was orchestration. The CLI compressed orchestration to seconds;
the bulk is now waiting for the agent.

Future work: N=5 or N=10 against each scenario, with mean ± stddev
reported. With CLI in place, N=10 is ~50 minutes of wall clock,
~0 minutes of human attention.

## Aggregate across all evaluations (eval 1-6 + multi-shot)

| Eval | Scenario | Score | Note |
|---|---|---|---|
| 1 | DDB | 63% | probe smoothing |
| 2 | DDB | (cheat) | chaos deletion |
| 3 | DDB | 82% | first legit run |
| 4 | DDB+feedback | 93% | first feedback-aware mitigation |
| 5 | Kinesis | 100% | fire-and-forget |
| 6 | S3 | 100% | write-ahead spool |
| MS1 | DDB-warmup | 23% | adaptive retry collapse |
| MS2 | DDB-warmup | 30% | plain retry partial |
| MS3 | DDB-warmup | 80% | stacked retry full |

Total: 9 subagent runs, 4 scenarios, 5 chaos drills exercised. Two
failure modes discovered without prior design (adaptive retry
collapse; multi-shot variance).
