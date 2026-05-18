# Tier 6 eval: duplicate-orders — state-correctness scenario solved at 100%

The first scenario where **probe success ≠ recovery**. Tests stateful
reasoning: the customer-facing endpoint returns 200, but the system
state (DDB row count vs customer request count) is wrong.

## Setup recap

- Baseline: `server.dup-prone.ts`. `writeOrder()` has the bug
  `randomUUID()` is called inside the app-level retry loop.
- SDK: `maxAttempts=1`, `socketTimeout=800ms`. Forces app retry on slow
  tail.
- Chaos: `latency-timeout-trap` — pure PutItem latency, p99=2s. Server
  completes; client times out at 800ms.
- Each retry generates a new id; the timed-out PutItem still persists
  server-side. Ghost rows accumulate.

`/orders` returns 200 (final-attempt id). `/dup-check` exposes
`sent_ids - returned_ids = ghosts`.

## What the agent did

```
T+N  read pages → notice "duplicate charges in last hour, 47 instances"
T+N  curl /kumo/chaos/rules → see latency-trap config (no errors)
T+N  curl /dup-check        → see ghosts > 0 and growing
T+N  read target source     → find randomUUID() inside retry loop
T+N  reason                 → "PutItem on same key is idempotent on DDB;
                              same id across retries fixes this"
T+N  edit: hoist randomUUID() and ts outside the loop
T+N  restart target
T+N  verify /orders 120/120 = 100%
T+N  verify /dup-check sent == returned at steady state
```

120 seconds wall clock. 17 tool uses.

Agent quote (state-correctness reasoning):
> "Post-fix, ghost count stays at 0; transient blips of 1 occur during
> in-flight retries but converge back to 0 because the retry reuses
> the same id."

This is the most precise state-convergence reasoning any subagent has
produced in the 26 runs so far. The agent explicitly distinguished
**persistent ghosts (the bug)** from **transient in-flight ghosts (the
race between sentIds.add and returnedIds.add)** and identified that
the fix resolves the former while preserving the latter as a benign
artifact of the metric.

## Result

| Criterion | Verdict |
|---|---|
| investigatedBeforeEditing | PASS |
| checkedKumoChaosStats | PASS |
| readTargetSource | PASS |
| statedHypothesis | PASS |
| didNotAddRetries | PASS |
| minimalCodeChange | PASS |
| recoveredSlo | PASS |
| customerImpactRecovered | PASS |
| chaosRulesPreserved | PASS |
| **noNewDuplicates** | **PASS** |

**100% rubric, 100% customer, 0 ground-rule violations.**

## Two new harness issues found during scoring

### Issue 1 — eval-score CLI didn't iterate __probe callbacks

The `noNewDuplicates` rubric primitive uses an async `__probe`
callback that the runner is supposed to invoke at scoring time, like
`customerImpactRecovered`. But `scripts/eval-score.ts` was written
before `noNewDuplicates` existed and hardcoded only the customer-impact
probe. New criteria's `__probe` was never called → result undefined
→ check returned false → FAIL despite agent's correct fix.

Fix: eval-score.ts now iterates `scenario.rubric`, calls `__probe()`
on any criterion that exposes it, and feeds all results to
`scoreScenario` via `postRunProbes`. Forward-compatible with future
async-rubric criteria.

### Issue 2 — `noNewDuplicates` was too strict

Initial implementation: "FAIL if r2.ghosts > r1.ghosts at 2s gap."
But the probe loop drives ~3 requests/sec; each in-flight request
contributes a transient ghost (sent but not yet returned). At any
moment 0-2 transients exist. The criterion incorrectly fired on these.

Fix: smoothed — sample 6 times over 10s, compare last-3 mean vs
first-3 mean, FAIL only if growth exceeds 10 (well above the in-flight
ceiling, well below real-bug accumulation rate).

This is the 9th rubric brittleness round. Pattern: each new rubric
primitive needs N runs to calibrate against actual signal-to-noise.

### Issue 3 — `checkedKumoChaosStats` regex too narrow

The text-evidence fallback matched `ddb-(peak|throttle)` rule IDs
but not the new `ddb-tail-latency-trap` ID. Agent referenced the
rule by exact name, regex missed it.

Fix: widened to `\bddb-[a-z][a-z0-9-]+` (any DDB rule ID) plus
similar patterns for sts/s3/kinesis/cognito/ec2/lambda services with
common rule suffix words (peak / throttle / cascade / down / tail / etc.)
and "Kumo-injected" phrase.

This is the same brittleness pattern — every new scenario adds new
rule IDs the regex must learn. Eventually a small LLM judge for these
text criteria is the right answer.

## Capability ladder update

Tier 6 (state correctness) is **solvable**. The agent demonstrated:

- Awareness that `/orders` success ≠ recovery
- Discovery of `/dup-check` (the auxiliary telemetry endpoint)
- Source diagnosis at line-level precision
- State-convergence reasoning (persistent vs transient ghosts)
- Verification beyond initial probe

The remaining open tiers are now mostly **harness extension** rather
than scenario complexity:
- Cross-incident learning (run sequence in same agent context)
- Time-to-recovery as numeric metric
- Production-quality discrimination (when multiple fixes work)

## Cumulative state

| | Value |
|---|---|
| Subagent runs | **26** |
| Scenarios | **13** |
| Drills | **11** |
| Mean best-of-N | ~95% across the catalog |
| Tier 1-6 status | **All solvable** |
| Rubric brittleness rounds | **9** |
| Stateful-correctness criterion | First successful |

The harness has run out of cleanly-defined "harder scenarios" within
its current chaos and rubric framework. Pushing further requires:

1. Multi-shot N≥5 on Tier 6 (confirm reproducibility)
2. Cross-agent benchmark (Sonnet vs Opus vs Haiku via Agent SDK)
3. Cross-incident learning loops (same agent does 5 scenarios in
   sequence; does scenario 5 go faster?)
4. New harness primitives (LLM-judged rubric criteria, time-to-recovery
   numeric scoring, restart-cost rubric)

These would push the boundary further, but they're harness work, not
scenario work.
