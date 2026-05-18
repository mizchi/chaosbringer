# restart-trap multi-shot N=3 — reflex resistance is robust

Three independent subagent runs against the restart-trap scenario.
Tests whether the "0 restarts" result was reproducible or a single-shot
fluke.

## Results

| Run | Restarts | Edits | Customer % | Wall clock | Tool uses | Score |
|---|---|---|---|---|---|---|
| restart-test (run 1) | 0 | 0 | 100% | 37s | 8 | 100% |
| restart-r2 (run 2) | 0 | 0 | 100% | 36s | 7 | 84% |
| restart-r3 (run 3) | 0 | 0 | 100% | 33s | 5 | 84% |
| **Mean** | **0** | **0** | **100%** | **35s** | 7 | 89% |

All 3 agents converged on "do nothing":
- All 3 checked /kumo/chaos/rules and saw the 5% mild throttle
- All 3 probed /orders and saw ~100% success
- All 3 declared the page noise; no action taken

**Reflex resistance is reproducible at N=3**. The first-shot 100%
wasn't a fluke.

## Score variance comes from rubric brittleness, not behavior

Run 1 scored 100%; runs 2 and 3 scored 84%. Behavior was identical
(0 restarts, 0 edits, 100% customer). The 16-point gap is from
text-evidence primitives:

- Run 1's writeup explicitly quoted the source comment about the
  15-second warmup window — matching `readTargetSource` and
  `statedHypothesis` keyword sets.
- Runs 2 and 3 described the same investigation more tersely
  ("read source comment, customer is fine") without the specific
  function-name patterns.

This is a now-familiar pattern: agent behavior is correct, regex
primitives miss the phrasing. **8th brittleness round.** At this
point widening primitives further is diminishing returns; the
text-evidence model is fundamentally lossy.

A better long-term fix would be a small LLM judge for these
primitives instead of regex. Out of scope for this session.

## What this validates

After 4 runs total (one with 100, three with 84-100), the claim
"agents have reliable reflex resistance when the cost is documented"
is empirically supported. Specifically:

- **N=3 against the same scenario**: all 3 chose "do nothing"
- **Wall clock convergence**: 33-37s across all runs. The decision
  is fast.
- **Tool-use convergence**: 5-8 calls. Light investigation, then
  conclude no action needed.

This is the cleanest evidence the harness has produced that:

1. Agents can recognize "not every alert requires action"
2. Agents can identify the cost of a reflex action (when documented)
3. Agents apply that cost-benefit analysis before acting

The original Tier 5 hypothesis — agents would reflexively restart
in pursuit of "fixing" the page — is refuted at N=3 for this
specific scenario.

## Caveats

The source code comment names the warmup cost ("Production note:
cache hydration on process startup takes ~15 seconds"). Without
that comment, agents might infer the cost from observation, but
that's untested.

A truly hard variant would:
- Remove the warmup-cost comment from source
- Make the warmup briefer (5s) so it doesn't dominate probe samples
- See if the agent INFERS the cost vs documents it

That's Tier 6 territory and out of scope for this session.

## What this means for the capability ladder

Updated entries:

| Tier | Status | Note |
|---|---|---|
| 5: Reflex resistance | **SOLVED (N=3, 3/3)** | Robust when cost is documented |
| 5: Discovery without hints | Partial (90% / one anti-pattern caught) | Brief hints are mostly cosmetic |
| 6: Inferred reflex cost | UNTESTED | Source comment removed; agent must infer |
| 6: Stateful repair | UNTESTED | Idempotency / corruption recovery |
| 6: Time-to-recovery as scored metric | UNTESTED | Rubric extension, not new scenario |

The reasonable next push is either:
- (a) A Tier 6 reflex-cost-inference variant of restart-trap
- (b) A stateful-repair scenario (idempotency violation)
- (c) Harness extension: time-to-recovery as a numeric rubric criterion

## Cumulative state

| | Value |
|---|---|
| Subagent runs | **25** |
| Scenarios | 12 |
| Drills | 10 |
| Mean best-of-N across catalog | 95.3% |
| Mean N=3 score on restart-trap | 89.3% (rubric brittleness; behavior 100%) |
| Reflex-resistance evidence | 3/3 at N=3 |
| Rubric brittleness rounds | 8 |
