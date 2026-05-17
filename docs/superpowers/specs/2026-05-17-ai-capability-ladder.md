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

## Tier 4: Multi-cause diagnosis — REPRODUCIBLY SOLVED

Scenarios where naive diagnosis is insufficient. As of compound-incident
(2026-05-17), this tier turned out to be solvable.

| Scenario | Best | Outcome | Why it was easier than expected |
|---|---|---|---|
| compound-incident | 100% (101s) | TWO independent issues (chaos + code bug). Both fixed in one shot. | The page text named both error codes; deploy-bot named the validation change; agent recognized "two error codes ≠ single cause" from the brief hint. |

What we learned from compound-incident:
- Brief hint about "two different error codes" is load-bearing. Without
  it, the agent might fix only one.
- The deploy-bot page at T+35s reinforced the code-bug signal.
- Single-shot 101s with two distinct mitigations applied correctly
  suggests agents handle 2-cause diagnosis well when each cause is
  individually surface-discoverable.

This implies: **multi-cause is not where the boundary lies**. Agents
follow alert text + chaos stats + source reading + deploy-bot
signals to find all the breadcrumbs the harness puts down.

The real boundary is where breadcrumbs are absent or misleading.

## Tier 5: Where the boundary probably lies (untested, expected hard)

Scenarios we have NOT yet built. Each removes a breadcrumb agents
rely on, or introduces a reflex anti-pattern.

| Concept | Why it's expected to be hard |
|---|---|
| **No-hints diagnosis** | Strip all alert / page / deploy-bot guidance. Agent gets only "checkout is slow" and must do full discovery. Tests whether agents over-rely on text breadcrumbs vs. independent investigation. |
| **Restart-causes-worse-failure** | Target has a slow-warming cache. Restart costs 5s of downtime AND empties the cache. Chaos is mild (10% throttle, easily absorbed by retries). The reflex to "restart and see" actively makes things worse. Tests resistance to restart-as-default. |
| **Capacity-choice / load-shedding** | Single endpoint can't both serve all traffic AND maintain SLO under chaos. Agent must implement priority-based shedding (premium vs free tier). Tests business reasoning, not just code reasoning. |
| **Phase-shifting incident** | Chaos changes shape at T+60s. Agent fixes Phase A, then must re-diagnose for Phase B with different cause. Tests not committing to the first hypothesis. |
| **Slow-burn cascade** | Chaos starts at 5% probability, scales to 50% over 90 seconds. Hard to detect early. By the time symptoms are obvious, the customer impact is severe. Tests early-detection skill (which our current scenarios don't reward). |
| **Asymmetric customer impact** | Chaos affects only 20% of partition keys persistently. Agent must implement targeted mitigation, not blanket. Tests cardinality reasoning. |
| **Stateful repair** | Chaos has already corrupted 200 DDB items. Agent must (a) stop bleeding (b) identify corrupted items (c) repair them. Tests stateful recovery, not just stop-bleeding. |
| **False recovery** | Mitigation appears to work on burst probes but degrades under sustained load (e.g. SDK adaptive retry collapse). Tests sustained verification beyond initial confirmation. |

## What we've observed about agent capability after compound-incident

After 21 subagent runs across 10 scenarios:

- **Multi-cause diagnosis works** when each cause has a breadcrumb
  (chaos stats / page text / deploy-bot signal).
- **Two distinct mitigations in one edit cycle is achievable** —
  the compound-incident agent applied cache + bug-fix in ~100s.
- **Brief hints are load-bearing but not solely sufficient** —
  agents who only read the hint without verifying via source +
  chaos stats produce worse mitigations.
- **The "8 agent failure modes" list (Tier 3 fault-fidelity issues)
  matters more than scenario complexity.** quota-saturated allows
  retry-amplification to work because the chaos model is forgiving;
  no amount of scenario complexity changes that.

## What pushing further would require

The Tier 5 list above. Specifically the easiest to build with high
boundary-finding value:

1. **No-hints diagnosis variant of an existing scenario** — same
   chaos as e.g. silent-credit-card-failures, but the alert text says
   only "customer impact elevated." See whether agents discover the
   feedback configuration without being told.

2. **Restart-causes-worse-failure** — needs a target with explicit
   warmup cost (sleep 5s on first request after process restart).
   Tests the most common LLM reflex (kill + restart) actively
   penalized by the harness.

3. **Phase-shifting via runScenario phases that mutate at fixed times** —
   the orchestrator already supports phases; just need a scenario
   where Phase 0 is "chaos type A" and Phase 1 (at T+60s) is "chaos
   type B" with different mitigation.

Each is small enough to build in one push. Any of them are likely
to land in the 60-85% range based on how the lower tiers scored.

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
