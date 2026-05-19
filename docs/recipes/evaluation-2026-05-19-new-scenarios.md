# Evaluation: 7 new "bug is yours" scenarios

Multi-shot agent evaluation across the seven scenarios added in the
2026-05-19 catalog expansion. Each ran a single fresh general-purpose
subagent against a freshly-prepared env, with the standard brief +
ground rules + 5-minute budget.

## Results

| Scenario | Score | Mitigation summary | Notable |
|---|---|---|---|
| memory-leak-gradual | **100%** | LRU bound (64 entries) + payload reduced 256KB→16B | All 8 rubric criteria PASS |
| regex-backtrack-dos | 91% | `/^(a+)+!$/` → `/^a+!$/` + `NOTE_MAX_LEN=256` | FAIL on investigate-before-edit (journal ordering) |
| cache-stampede-expiry | 78% | Singleflight via in-flight Promise in `getTier()` | 2 FAILs on investigate / read-source-first |
| disk-full | 67% | Replaced `logRequest()` body with no-op | 3 FAILs on process criteria; mitigation correct |
| clock-skew-rejection | **100%** | `CLOCK_SKEW_MS = 30_000 → 0` | All 8 PASS |
| schema-mismatch | **100%** | Read-path shim: accept v1 rows in /verify | All 8 PASS |
| pg-bouncer-overload | **100%** | `BOUNCER_MAX = 3 → 20` | All 8 PASS |

**Mean: 91%.** Mitigation correctness was 7/7 — every agent reached
the canonical fix the rubric rewards. The 3 sub-100% scores all lost
points on **process criteria** (LLM-judged investigate-first / read-
source-first / stated-hypothesis), not on the mitigation itself.

## Per-scenario notes

### memory-leak-gradual (100%)
Agent confirmed via `/__mem` that `retainedRequests=764` and ~200MB
retained payload; read source; identified the unbounded
`recentRequests.set(...)`; applied LRU eviction at 64 entries AND
reduced the per-request payload from 256KB to 16B since it was never
read. 40/40 success after restart. RSS stable at ~100MB vs 307MB
pre-fix. Clear time-progression diagnosis.

### regex-backtrack-dos (91%)
Agent recognized ReDoS pattern from the page hint, read source,
found `NOTE_VALIDATION_REGEX = /^(a+)+!$/`, replaced with the linear
equivalent `/^a+!$/`, added a defensive `NOTE_MAX_LEN = 256` cap.
40/40 with previously-pathological inputs. Agent self-noted "I jumped
from page hints straight to source" — which the LLM judge then
penalized as not investigating before editing.

### cache-stampede-expiry (78%)
Agent applied the canonical singleflight pattern using a
module-scoped `tierInflight` Promise. Concurrent misses share the
same in-flight call. 40/40 with p99 < 700ms. The two process FAILs
were also self-reported in the agent's "what I'd do differently"
section: it burned 3 minutes on a flaky restart and didn't journal
its initial reads explicitly enough.

### disk-full (67%)
Agent replaced the logRequest body with a no-op, durably mitigating
the log volume cap. 100/100 success across two test rounds. The
agent's summary correctly identified "Kumo and DDB were red
herrings", but the rubric's investigate-first / read-source-first /
hypothesis criteria all came back FAIL — the LLM judge looked at
journal order and didn't see explicit Read entries before the Edit.
A real ops handoff would absolutely consider this an A-grade fix;
the scoring is penalty-heavy on process formality.

### clock-skew-rejection (100%)
Cleanest run of the batch. Agent followed the journal-ordering
instructions exactly: page reads → `/__clock` → source read →
explicit hypothesis → one-line `CLOCK_SKEW_MS = 0` edit → restart →
verify. 40/40 after fix.

### schema-mismatch (100%)
Agent identified the half-deployed-fleet pattern via
`/__schema-stats`, read the variant source, and chose the read-path
shim (accept v1 OR v2). Did not touch the write path, leaving the
deploy free to roll forward or back. 40/40 place+verify round-trips.

### pg-bouncer-overload (100%)
Hardest scenario by design — the diagnostic surface is the
asymmetry between bouncer stats (queue depth) and pool stats
(idle, no waiting). Agent identified the smoking gun on `/__bouncer`
("active=2-3, max=3, acquired climbing") on first read, raised
BOUNCER_MAX from 3 to 20. 40/40 at concurrency 10, p99=0.55s.

## Process-vs-outcome breakdown

| Scenario | Process FAILs | Outcome (mitigation correct + SLO recovered) |
|---|---|---|
| memory-leak | 0 | ✅ |
| regex-dos | 1 (investigate-first) | ✅ |
| cache-stampede | 2 (investigate / read-source) | ✅ |
| disk-full | 3 (investigate / read-source / hypothesis) | ✅ |
| clock-skew | 0 | ✅ |
| schema-mismatch | 0 | ✅ |
| pg-bouncer | 0 | ✅ |

The pattern: when the brief includes explicit journal-ordering
guidance (`T+<s>s read: <path>` BEFORE `T+<s>s edit: ...`), agents
hit 100% on the process criteria. When the brief omits that
guidance, agents tend to investigate efficiently but skip the
formal journal entry, and the LLM judge flags it.

For the harness's purpose this is a **legitimate gap in agent
behavior** the rubric catches — real on-call needs documented
reasoning, not just correct outcomes — though the auto-eval
penalty may overweight formality vs technical correctness.

## Catalog coverage validated

The seven new scenarios all demonstrate end-to-end agent solvability
with the canonical mitigation. Combined with the prior 22 scenarios,
the catalog now offers a stable test surface across:

- AWS-SDK-mediated (15 scenarios)
- Real Postgres (4 scenarios: pool / replica / slow / bouncer)
- Network layer (3 scenarios: dns-race / mid-flight RST / dns-storm)
- "Bug is yours" no-external-chaos (8 scenarios)
- Multi-service topology (1 scenario)

All 29 scenarios run via the same `pnpm prepare` / `pnpm score`
pipeline, all support the journey-based customer probe, and all
have working LLM-judged rubric criteria.

## Files

- `/tmp/wom-eval-{memleak,regex,cache,disk,clock,schema,bouncer}-1/`
  — full debriefs + report.json per scenario.
