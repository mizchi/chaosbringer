# Tier 5 evals: restart-trap and no-hints-storm

Two scenarios from the Tier 5 list in the capability ladder. Each
removes a breadcrumb agents normally rely on or tests a reflex
anti-pattern.

## Results

| Scenario | Score | Customer % | What happened |
|---|---|---|---|
| restart-trap | **100%** | 100% | Agent decided NO action was needed. 0 restarts, 0 edits, 37s. |
| no-hints-storm | **90%** | 97% | Customer recovered, but agent applied 6-attempt retry wrapper — anti-pattern under feedback chaos. `didNotAddRetries` FAIL'd. |

## restart-trap — reflex resistance demonstrated

The first scenario in the catalog where the right answer was "do
nothing." The agent:

1. Checked chaos stats: 5% throttle, no feedback config visible
2. Probed /orders: 40/40 = 100%
3. Read source: noticed the explicit "15-second warmup window" comment
4. Decided: chaos is real but absorbed; no action needed; restart
   would actively make things worse

Agent quote:
> "kill-and-restart would have caused real customer downtime to
> 'fix' something the system already absorbs."

37 seconds wall clock. 8 tool_uses. ALL 10 rubric criteria PASS,
including the new `avoidedUnnecessaryRestart(maxRestarts=0, weight=5)`.

This is a significant finding: **the agent has measurable reflex
resistance**. The Tier 5 hypothesis that "agents reflexively
restart" is at least partially refuted. When the source comment
made the restart cost explicit AND the probe data showed customer
was fine, the agent didn't restart.

Caveat: the source comment essentially named the answer. A weaker
form of the scenario (no warmup-cost comment in source) would test
whether the agent INFERS the restart cost from observing.

## no-hints-storm — discovery happens; reflex doesn't change

Identical chaos to silent-credit-card-failures (2015 DDB feedback
storm), but the brief, pages, and groundTruth strip all hints
about what to expect. The agent has only:

> "OrderService: success rate down. Customer support seeing
> 'order failed' patterns. On-call paged."

No mention of feedback. No mention of retry storms. No mention of
the recent deploy. No CloudWatch cascade chatter.

What the agent did:
1. Checked chaos stats — saw ddb-peak with feedback config (the
   shape is visible in the rule JSON even if the brief doesn't say it)
2. Read source — found writeOrder's 3 sequential AWS calls
3. Applied: 6-attempt retry wrapper around all calls with
   exponential backoff

Result:
- Customer 40/40 = 100% sustained (probably below feedback
  threshold by luck of timing)
- `didNotAddRetries` FAIL'd (correctly — 6 retries is the
  anti-pattern under feedback)
- Score 90%

Insight from this run: **the brief's "feedback warning" doesn't
change agent behavior much**. Comparing to silent-credit-card-failures
which DID have the warning:
- sccf-cli (warning present): agent applied maxAttempts=1 +
  backoff > feedback window → 100%
- sccf-cli-r2 (warning present): agent applied parallelize +
  maxAttempts=5 → 57%
- sccf-cli-r3 (warning present): agent applied maxAttempts=3 +
  semaphore → 76%
- no-hints-storm (warning absent): agent applied 6-attempt
  wrapper → 90%

Pattern: the warning helps some agents (sccf-cli) but not others
(sccf-cli-r2/r3). And the absence of warning doesn't degrade much
(no-hints scored 90%, similar to sccf-cli-r2/r3).

Conclusion: brief hints are mostly **cosmetic** when the rubric
catches the anti-pattern via process criteria. The agent reaches
for first-instinct mitigations regardless; the warning just
affects how they describe their thinking, not their action.

## Updated capability ladder

| Tier | Description | Status |
|---|---|---|
| 1 | Single canonical fix | 5 scenarios at 100% |
| 2 | Multiple right-looking mitigations | 3 scenarios, variance |
| 3 | Process passes, model fails the lesson | quota-saturated |
| 4 | Multi-cause diagnosis | **compound-incident 100%** |
| 5 | Reflex resistance | **restart-trap 100%** ✅ |
| 5 | Discovery without hints | **no-hints-storm 90%** (close to ceiling but with anti-pattern caught) |

Tier 5 turned out to be only partially-hard:
- **restart-trap**: solvable when source documents the cost.
  Truly hard variant: target with EXPENSIVE warmup that's not
  obviously documented; agent must INFER from probe data alone.
- **no-hints-storm**: solvable in outcome but anti-pattern still
  applies. Tests showed brief hints are weakly load-bearing.

## What's actually left

After 23 subagent runs across 12 scenarios, the true capability
boundary isn't where we thought:

- **Multi-cause is fine** (compound-incident solved cleanly)
- **No-hints is fine for outcome** (90% even without breadcrumbs)
- **Reflex resistance exists** (restart-trap, 0 restarts)
- **Anti-patterns persist regardless of hints** (retries appear in
  4 of 12 scenarios despite brief warnings)

The remaining open tier is **what's not caught by rubric**:
- Production-quality vs naive mitigation when both work in our
  fault model
- Subtle data corruption that requires state-aware repair
- Time-to-recovery (currently captured but not rubricized)
- Cross-incident learning (does the agent apply lessons from one
  scenario to a similar future scenario? Multi-shot of the same
  agent could test this)

These require harness work, not just more scenarios.

## Cumulative state

| | Value |
|---|---|
| Scenarios | 12 |
| Drills | 10 |
| Subagent runs total | **23** |
| Real-incident replays | 5 (2015 / 2017 / 2020 / 2021 / 2025) |
| Mitigation directions | 8 (added "no-op / observe-only") |
| 100% best-of-N | 8 of 12 |
| Rubric brittleness fixes | 7 (added "Root cause(s):" + function names + "code-level" phrase recognition) |
| Tier 5 scenarios designed | 2 of 8 |
| Tier 5 scenarios solved | 1 (restart-trap full) + 1 partial (no-hints) |

## The 12-scenario aggregate

```
ddb-throttle-warmup               80% (calibration; varies with retry config)
silent-credit-card-failures      100% (best-of N=3; mean ~78%)
morning-rush-cognito             100% (Kinesis hidden upstream)
checkout-receipts-stalled        100% (S3 WAL pattern)
misleading-chaos                 100% (chaos distraction, find code bug)
control-plane-degraded           100% (2021 STS hot-path)
quota-saturated                   88% (process FAIL on retry direction)
ddb-dns-race                      88% (connection-level mitigation; red herring)
tier-lookup-stampede             100% (add cache; first ADD-code scenario)
compound-incident                100% (2 issues, 2 fixes, one shot)
restart-trap                     100% (0 restarts; first 'do nothing')
no-hints-storm                    90% (no breadcrumbs; outcome OK, process FAIL)
```

Mean: 95.3% best-of. 8 perfect, 3 in the 88-90 band (rubric anti-pattern
caught), 1 at 80 (calibration noise).
