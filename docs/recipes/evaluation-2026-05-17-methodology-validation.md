# Methodology validation (2026-05-17)

A 16th subagent run, executed by following the just-written
`.claude/skills/aws-chaos-rehearsal/SKILL.md` step-by-step.
The point isn't a new finding — it's to confirm the documented
methodology runs cleanly without any of the cumulative session
context required for the prior 15 runs.

## Procedure followed

Exactly the four steps from the skill:

```
1. Verify env up: curl kumo /health + proxy /kumo/chaos/rules + target /
2. pnpm prepare misleading-chaos mc-validation
3. Spawn agent with the printed brief (Claude Code Agent tool)
4. pnpm score misleading-chaos mc-validation
```

No manual chaos rule installation, no hand-rolled page board,
no custom probe loop. The CLI and the skill did everything.

## Result

| Metric | Value |
|---|---|
| Score | 100% |
| Customer impact (post-run probe) | 100% |
| Wall clock (agent only) | 54s |
| Tool uses | 10 |
| Ground rule violations | 0 |

Two independent misleading-chaos runs:

| Run | Score | Customer % | Wall clock | Tools |
|---|---|---|---|---|
| mc-eval (original) | 100% | 100% | 65s | 14 |
| mc-validation (this) | 100% | 100% | 54s | 10 |
| **Mean** | **100%** | **100%** | 60s | 12 |
| **Range** | 0 | 0 | 11s | 4 |

Adversarial scenarios produce remarkably consistent agent behavior:
both agents found the validateOrder() throw, both no-op'd it, both
verified with /orders bursts before declaring recovery. The reason
the variance is so low compared to harder scenarios: there's only
one correct fix (remove the bug), and any agent that reads the
source will see it.

## What this validates

1. **The skill is self-contained.** A user who has never seen the
   prior 15 runs can follow the four steps and produce a working
   eval. No tribal knowledge required.

2. **The CLI handles all setup correctly.** No leftover state from
   the previous runs leaked into this one. The skill's "reset to
   fragile/buggy baseline + restart target" was reliable.

3. **The rubric scores the same way for the same behavior.** mc-eval
   and mc-validation got identical 100% with the same mitigation
   path. Rubric is deterministic on equivalent inputs.

4. **The harness is stable across sessions.** This run was the 16th
   in the session; the harness state (kumo, proxy, target) was
   resilient enough that even after 5+ chaos config changes and
   2 target binary reloads, the prepare CLI fully reset everything.

## What changed vs. the documented expectation

Nothing. The skill predicted "competent agents score 80-100%; the
adversarial scenario specifically tests over-fitting to chaos
stats" — that's exactly what we observed in both runs.

The only minor variance: tool_use count differs (14 vs 10).
That's consistent with agent-side decision variation (whether to
also tail /tmp/target.log; how many probe bursts to verify with).

## Total runs after this batch

| Scenario | Total runs |
|---|---|
| ddb-throttle-warmup | 3 |
| silent-credit-card-failures | 3 |
| morning-rush-cognito | 2 |
| checkout-receipts-stalled | 2 |
| misleading-chaos | **2** (was 1) |
| **Total** | **12** at session count, **16** subagent runs total |

Subagent runs total: **16**. Five scenarios. Eleven CLI-era runs.

## What we'd do next

The methodology now repeats reliably. Future iterations:
- More scenarios from the existing drill catalog (2021 us-east-1
  is the obvious next one; needs minor target wiring for STS).
- N≥5 multi-shot on each scenario for tighter confidence intervals.
- Cross-agent comparison (Sonnet vs Opus vs Haiku running the same
  scenarios via the SDK driver) — once an API key is wired up.
