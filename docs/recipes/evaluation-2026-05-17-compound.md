# Compound-incident eval: Tier 4 turned out to be solvable

The compound-incident scenario was designed to push past Tier 3 of the
capability ladder. Two independent issues active simultaneously:
- Chaos: feedback throttle on DDB GetItem (tier-config hot key)
- Code: validatePayment() throws on ~25% of requests

Single-fix mitigations land below the 80% acceptance bar:
- Cache only (fix chaos) → customer ~75%
- Validate fix only (fix code) → customer ~30-50%
- Both → 100%

## Result

| Metric | Value |
|---|---|
| Score (after rubric tightening) | 100% |
| Customer impact (post-run, 30 samples) | 100% |
| Wall clock | 101s |
| Tool uses | 16 |
| Ground rule violations | 0 |

The agent applied BOTH fixes correctly in one edit cycle:
1. Added in-memory TTL cache (30s) for getTierConfig with
   stale-on-throttle fallback
2. Removed the bogus validatePayment throw

Two consecutive 40-sample bursts: 40/40 + 40/40 = 80/80 = 100%.

## What the agent saw and how it reasoned

From the agent's summary:
> Root causes (two independent issues, as alert hinted):
> 1. DDB throttle (chaos): tier-config GetItem hit on every request...
> 2. App regression bug: validatePayment() had a Math.random() < 0.25
>    throw of PaymentValidationError introduced by recent deploy.

The "as alert hinted" parenthetical is the key tell — the brief's
mention of TWO error codes (PEx AND PaymentValidationError) signaled
to the agent that single-cause hypothesis was wrong. The deploy-bot
page at T+35s ("changes touched validation logic") confirmed the
second cause.

## Rubric brittleness, again

Initial score: 71%. The agent's writeup used:
- "Root causes (two independent issues...)" — but our
  statedHypothesis regex matched only "hypothesis / cause /
  because" stem keywords.
- Specific function names like "validatePayment" and
  "getTierConfig" — but our readTargetSource regex matched only
  "writeOrder / tryWriteOrder" specifically.

Updated:
- statedHypothesis now accepts "Root cause(s):" and "Cause:" headers
- readTargetSource accepts function-name references including
  validatePayment, validateOrder, getTierConfig, checkIdentity
- Also matches "on every request" / "code-level" / "app regression"
  phrases

After fix: 100%. The agent's competence was correctly captured.

This is the 6th rubric brittleness round in the eval series. Pattern:
each new agent writeup style exposes a phrasing the regex doesn't
handle. Tradeoff is widening regexes vs increasing false positives.
We've been on the false-negative side most rounds; agent text is
varied enough that strict regex isn't viable.

## Updated capability ladder

Tier 4 (compound-incident) is solvable. The boundary is now
hypothesized at Tier 5, where breadcrumbs are absent or where the
agent's reflex (restart, retry) actively harms.

Tier 5 candidates:
- No-hints diagnosis (strip alert + page guidance)
- Restart-causes-worse-failure (warmup-cost target)
- Capacity-choice / load-shedding (business reasoning required)
- Phase-shifting incident (chaos changes mid-run)
- Slow-burn cascade (early-detection skill)
- Asymmetric customer impact (cardinality reasoning)
- Stateful repair (corrupted data, not just chaos)
- False recovery (sustained-load detection)

See `docs/superpowers/specs/2026-05-17-ai-capability-ladder.md` for
the full ladder with detail on each Tier 5 concept.

## What this run validates

After 21 runs across 10 scenarios, the harness reliably:
- Distinguishes process-correct from process-shortcut agents
  (rubric primitives catch the "obvious" anti-patterns)
- Surfaces fault-model fidelity gaps (the 5 brittleness rounds and
  the quota fault-model issue)
- Measures multi-cause diagnosis as a discrete skill (compound-incident
  is the first scenario that REQUIRES two unrelated mitigations)

What it doesn't yet distinguish:
- Brilliant vs adequate problem-solving when the chaos is "easy"
  enough that adequate works
- Discovery without breadcrumbs (Tier 5 will test this)
- Reflex resistance (Tier 5 restart scenario will test this)

## Cumulative state after this batch

| | Value |
|---|---|
| Scenarios | 10 |
| Drills | 9 |
| Subagent runs total | **21** |
| Real-incident replays | 5 (2015 / 2017 / 2020 / 2021 / 2025) |
| Mitigation directions covered | 7 (remove / decouple / persist / cache / bound / throttle / multi-fix) |
| Tier 1-4 reliably solved | 7 of 10 scenarios at 100% best-of-N |
| Documented rubric brittleness fixes | 6 |
| Fault-model fidelity gaps to close | 1 (quotaExhaustion needs feedback) |
