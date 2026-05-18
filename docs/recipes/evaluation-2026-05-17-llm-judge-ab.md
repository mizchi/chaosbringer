# LLM-judged rubric A/B benchmark

The first empirical measurement of regex vs LLM agreement on the
text-evidence rubric primitives. Run via `pnpm benchmark-rubric` over
20 historical eval runs.

## Setup

- 20 runs from /tmp/wom-* with transcript + journal preserved
- 3 LLM-judgeable criteria per run: stated-hypothesis,
  read-target-source, checked-chaos-stats
- Total potential verdicts: 60
- LLM verdicts populated for 10 of the 20 runs (via subagent acting
  as the judge — no Anthropic API key available in this env, so a
  general-purpose subagent applied the same questions and wrote
  /tmp/wom-<run>/llm-verdicts.json)
- Pure regex re-score: 20 runs × 3 = 60 verdicts
- LLM-aware re-score: 10 runs × 3 = 30 verdicts

## Result: 3 deltas / 30 verdicts (10%)

| Case | Regex | LLM | Direction |
|---|---|---|---|
| multi-shot-run1 / stated-hypothesis | FAIL | PASS | regex too strict (missed valid evidence) |
| sccf-cli-r2 / read-target-source | PASS | FAIL | regex too lenient (matched vague text) |
| sccf-cli-r3 / read-target-source | PASS | FAIL | regex too lenient (matched vague text) |

Both error directions appear. The 9 rounds of regex widening over the
session reduced false negatives (regex too strict) but introduced new
false positives (regex too lenient). The widening pattern is
asymmetric: catching missing evidence usually requires adding broad
keyword/phrase patterns; those same patterns then match vague text
that doesn't actually demonstrate the behavior.

## Per-direction interpretation

**Regex-too-strict (multi-shot-run1, 1 case)**:
The agent's writeup didn't use the specific keywords ("hypothesis",
"cause:", "root cause") that the regex required. But the agent DID
describe their reasoning explicitly. LLM correctly recognized the
hypothesis statement.

**Regex-too-lenient (sccf-cli-r2 and sccf-cli-r3, 2 cases)**:
The agents wrote phrases like "three synchronous AWS writes" that
matched the `synchronously` keyword pattern in readTargetSource's
regex. But the LLM judged these as INSUFFICIENT: no function names,
no specific code structure references. The agents probably did read
source (they edited it), but their post-incident summary doesn't
prove it.

This is an interesting case. The LLM is being STRICTER than regex.
For read-target-source specifically, "did the agent read source"
should be measurable from tool_uses (Read events on target/*) — and
those PASS via the tool-use path regardless of text. The text
fallback only fires when tool_uses don't capture the read (e.g. when
journal is the only record). In those cases, demanding specific
code references (LLM) is the right bar.

## What this means for the rubric

After 9 rounds of regex widening, the framework is converging on
LLM judgment for ~90% of cases. The remaining 10% is where:
- Agents paraphrase outside the regex's keyword set
- Agents use vague phrases that the regex matched too eagerly

For the harness to be reliable at scale, LLM judging needs to be the
default for text-evidence primitives. Regex is fine as a fallback
when no API key is available — it's wrong in both directions but
predictably wrong, and the magnitude is small (10% miscategorization).

## Cost

A single LLM judge call is ~50 tokens output, ~500-1500 tokens
input (transcript + journal excerpt). Using
`claude-haiku-4-5-20251001`: roughly $0.001 per call. 3 criteria
× 20 runs per session = 60 calls = $0.06 per eval-of-evals session.
Negligible.

## Plumbing validated by this benchmark

The runner now correctly:
1. Reads `probes.log` into `probeTrace` (for restartCost,
   timeToRecovery — synchronous trace-derived criteria)
2. Iterates `__probe` callbacks in parallel (customerImpactRecovered,
   noNewDuplicates — async network probes)
3. Iterates `__llmJudge` callbacks in parallel (statedHypothesis,
   readTargetSource, checkedKumoChaosStats — async LLM calls)
4. Feeds all results into scoreScenario via the extended
   ScoringContext (probeTrace + llmVerdicts + postRunProbes +
   postRunChaosSnapshot)

This is a complete rubric architecture: pure-text (regex), async
text (LLM), async network (probes), and synchronous trace (logs).

## Cumulative state

| | Value |
|---|---|
| Subagent runs | 26 (eval) + 2 (judge) = 28 |
| Scenarios | 13 |
| Drills | 11 |
| Rubric primitives | 13 |
| Async rubric callbacks supported | __probe, __llmJudge |
| Synchronous trace-derived criteria | restartCost, timeToRecovery |
| LLM-judgeable primitives | 3 (statedHypothesis, readTargetSource, checkedKumoChaosStats) |
| Empirical regex/LLM disagreement rate | **10%** (3 / 30 verdicts) |

## Next

With LLM judging in place:
- Set `ANTHROPIC_API_KEY` and re-score the 10 unjudged runs to
  complete the 60-verdict dataset.
- For NEW evals, the eval-score CLI dispatches __llmJudge
  automatically when the API key is set. Cost is bounded (~$0.001
  per criterion).
- Could add LLM-judged versions of other criteria
  (didNotAddRetries, minimalCodeChange) — currently regex-only and
  arguably brittle in the same way.
