# AI on-call capability ladder

**Date:** 2026-05-17
**Project:** chaosbringer / aws-faults
**Status:** Working document; updated after each new scenario class

What general-purpose Claude subagents solve reliably, sometimes, or
not at all. Based on 20 subagent runs across 9 scenarios. Used to
decide where to add hard scenarios next.

The ladder is **not** about agent intelligence — it's about which
failure shapes our harness can repeatably solve via the
prepare-spawn-score loop, and which ones we should expand toward to
push the boundary.

## Tier 1: Reliably solved (best-of-N = 100%)

Every agent in every run found the right answer in well under the
budget. These shape a *floor*: if you can build a target that
exhibits this pattern, an agent will recover it.

| Shape | Scenario | Why agents nail it |
|---|---|---|
| Remove gratuitous AWS call | control-plane-degraded | One canonical fix; source comment names the anti-pattern; chaos stats point clearly at STS |
| Find-and-remove code bug | misleading-chaos | Chaos `matched=0` rules out external; source-reading is the only path |
| ADD a cache layer | tier-lookup-stampede | Brief hint ("ADD code"); chaos targets specific action; feedback stops on cache hit |
| Decouple invisible audit | morning-rush-cognito | Hint about non-critical data; clear customer-path identification |
| Add write-ahead log | checkout-receipts-stalled | Brief hints about durability; agent generalizes from prior fire-and-forget patterns |

Common features:
- **One canonical mitigation** that matches the failure shape
- **Chaos stats unambiguously** point at the upstream (or matched=0
  rules it out)
- **Source reading reveals the issue** in 1-2 functions
- **Brief contains either an explicit hint or a deploy-bot signal**

## Tier 2: Sometimes solved (mean = 60-90%)

Variance is large. Some agent runs hit 100%, some land below the
acceptance threshold. The right mitigation exists but isn't unique;
agents oscillate.

| Shape | Best | Worst | Mean | Cause of variance |
|---|---|---|---|---|
| Feedback retry storm (2015 DDB) | 100% | 57% | 78% | Many "tune retry config" parameter combinations; only some converge |
| Simple throttle (ddb-throttle-warmup) | 80% | 23% | 44% | adaptive vs standard retry mode choice |
| Connection-level (dns-race) | 88% | n/a | n/a | Agent oscillates SDK config before app-level retry |

Common features:
- **Multiple "right-looking" mitigations** — retry depth × timeout ×
  backoff × concurrency cap × adaptive mode
- **One of those is a trap** (adaptive retry collapse, increasing
  retries under feedback)
- **Multi-shot reveals significant variance** — single-shot can
  overstate by 20+ points

## Tier 3: Process passes, model fails the lesson (88%-100% outcome, but wrong direction)

Outcome is recovered but the mitigation would NOT work in
production. The chaos model isn't faithful enough to punish the
wrong move.

| Shape | Outcome | Anti-pattern applied | Root cause |
|---|---|---|---|
| quota-saturated | 97% customer recovery | 6-attempt withRetry | Drill uses fixed-probability chaos, not real soft-quota rate-limiting. Retries trivially win. |
| ddb-throttle-warmup (pre-feedback) | 100% sometimes | maxAttempts=8 | Without feedback, more retries genuinely help here. |

These are **fault-model fidelity bugs**. The rubric catches the
anti-pattern via `didNotAddRetries` but outcome agrees with the
agent. To close: upgrade the chaos model so the wrong mitigation
makes things tangibly worse.

## Tier 4: Untested but designed for (next iteration)

Scenarios we've designed but not yet built/run. These push toward
where agents are expected to struggle.

| Concept | What it tests |
|---|---|
| Compound incident (chaos + code bug) | Multi-cause diagnosis. Both must be fixed; either alone leaves SLO below threshold. |
| Phase-shifting incident | Adaptability. Chaos changes mid-run; agent must re-diagnose. |
| Capacity-choice scenario | Value reasoning. Single endpoint can't serve all customers; agent must implement priority shedding. |
| Restart-causes-worse-failure | "Restart is not the answer" anti-pattern; restart loses warm caches. |
| Data corruption requires repair | Stateful recovery; stop-bleeding ≠ recovery. Must repair existing bad data. |
| Slow-burn cascade | Early-detection skill; chaos barely perceptible at first. |
| Cardinality-aware | Chaos affects only a subset of customers (sharding/segmentation reasoning). |

## What we've found WORKS for getting reliable evals

After 20 runs:

1. **Process criteria with text-evidence fallback** outscore strict
   tool-use checks. Agents describe what they did in different
   words; regex+keyword cover that.
2. **Customer-impact probe (separate endpoint)** is the most stable
   signal. Probe-smoothing was an early cheat; an independent
   probe at score time exposes it.
3. **`chaosRulesPreserved` + read-only proxy** closes the
   "DELETE the test" cheat at two layers.
4. **Feedback chaos** is the most effective way to punish wrong
   mitigations via outcome (not just rubric). When the chaos itself
   gets worse from retries, agents converge faster.
5. **Hints in the brief work** — "may require ADDING code" produced
   the cleanest tier-lookup-stampede run. Hints risk over-steering
   but rubric weighting compensates.

## What we've found does NOT WORK

1. **`rereadPageBoard` rubric criterion** — failed in all 5+ runs
   that included it. Agents read pages once. Either bake critical
   info into later pages so re-reading is mandatory, or drop the
   criterion.
2. **Telling the agent to journal verbosely** — half do, half don't.
   Better: scrape what they actually did from filesystem + restart
   logs.
3. **Score variance below ~15 percentage points isn't meaningful** —
   agent decision variance dominates. Multi-shot only useful for
   N≥3.

## Where the boundary actually lies

The harness can reliably distinguish:
- Competent vs incompetent agents (100% vs <60% gap)
- Process-correct vs process-shortcut agents (chaosRulesPreserved,
  didNotAddRetries, customerImpactRecovered)
- Heuristic vs shortcut use of chaos stats (misleading-chaos test)

The harness cannot yet distinguish:
- Mitigation A vs mitigation B when both work (e.g., cache vs
  decouple when both would recover SLO)
- Production-quality vs naive mitigation when the chaos model is
  too forgiving (quota-saturated case)
- Time-to-recovery skill — currently captured as wall-clock but
  not rubricized

The next hard scenarios should target the cannot-yet-distinguish
list. See `2026-05-17-hard-scenario-proposals.md` for what's coming
next.
