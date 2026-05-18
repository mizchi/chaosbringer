# LLM-judge A/B benchmark — complete dataset (20 runs × 5 criteria)

Follow-up to the partial A/B benchmark, now with full coverage:
20 runs, 5 LLM-judgeable rubric primitives, 100 verdicts.

## Coverage

| Criterion | Approach | Deltas | Notes |
|---|---|---|---|
| checked-chaos-stats | regex with rule-id widening | 0 | Stable after eval-6 widening |
| stated-hypothesis | regex with "root cause(s):" headers | 1 | regex too strict |
| read-target-source | regex with function name + phrase OR | 3 | regex too lenient |
| no-extra-retries | regex with Mitigation-section detection | 0 | Stable after eval-4 fix |
| minimal-change | tool_use count | 0 | Pure count, no text |

**Total: 4 deltas / 100 verdicts (4%).**

## All 4 deltas

```
multi-shot-run1 / stated-hypothesis: regex ❌, LLM ✅  (regex too strict)
restart-test    / read-target-source: regex ✅, LLM ❌  (regex too lenient)
sccf-cli-r2     / read-target-source: regex ✅, LLM ❌  (regex too lenient)
sccf-cli-r3     / read-target-source: regex ✅, LLM ❌  (regex too lenient)
```

## Why read-target-source is the worst offender

3 of the 4 deltas are read-target-source. The regex uses generic
patterns like `synchronously on (customer|customer-path|hot)`,
`writes (to )?DDB (and|then) Kinesis`, etc. — phrases agents use in
both "I read the source carefully" writeups AND in "I'm describing
what the customer path does at a high level" writeups.

The LLM judge distinguishes:
- "writeOrder() calls doc.send() with PutCommand..." → YES (specific)
- "the application handles X synchronously" → NO (vague)
- "the target makes 3 sequential AWS writes" → NO (no code reference)

These are subtle for regex. The pattern is "did the agent reference
SPECIFIC code identifiers" which doesn't reduce to keyword matching.

## Why didNotAddRetries and minimalCodeChange are stable

- `didNotAddRetries` has section-aware scanning (eval-4 fix). When
  the transcript has `Mitigation:` header, regex scans only that
  region. The bug-description vs mitigation distinction is captured
  structurally, not semantically. LLM agrees in all 20 cases.

- `minimalCodeChange` is a tool_use count, not text. Either the
  agent edited ≤N times or not. No text-evidence brittleness
  possible. LLM also agrees in all 20 cases.

## Implications for the rubric architecture

Of the 5 LLM-judgeable primitives, only `read-target-source` would
benefit substantially from LLM judging in routine evals. The others
are 0-1% disagreement — within noise.

For routine evals (no API key needed): regex is fine.
For benchmarking, peer-reviewed publication, or boundary
investigation: enable LLM judging via API key — costs ~$0.06 per
20-run session, fixes the ~4% of cases where regex is wrong.

This is the FIRST EMPIRICAL EVIDENCE that the rubric is reliable
enough for cross-session comparison. Prior to this benchmark, the
9 rounds of regex widening were anecdotal — we knew there were edge
cases but not the rate. Now we know: 4% disagreement, concentrated
in one criterion, with a clear semantic explanation.

## Cumulative state

| | Value |
|---|---|
| Subagent runs | 26 eval + 5 judge = 31 |
| Scenarios | 13 |
| Drills | 11 |
| Rubric primitives | 13 |
| LLM-judgeable primitives | 5 of 13 |
| Empirical regex-LLM agreement | 96% (96/100 verdicts) |
| Worst primitive | read-target-source (15% disagreement at N=20) |
| Cost per session if API key set | ~$0.06 (haiku-4-5) |

## What this completes

The rubric architecture now has:
- 4 evaluation layers: regex / async-LLM / async-network / sync-trace
- Empirically calibrated disagreement rate
- Forward-compatible: new criteria add their own `__llmJudge` or
  `__probe` callback; runner discovers automatically
- Functional offline (regex fallback); enhanced online (LLM API)

The 9 rounds of regex brittleness rounds → an architectural pattern.
Each new scenario can add its own LLM judge if needed. Cost is
bounded by the number of criteria, not the number of scenarios.

## What's left

- Add LLM-judged versions for trace-derived criteria? No — those are
  numeric, no text brittleness.
- Add LLM-judged versions for chaosRulesPreserved? No — that's a
  state snapshot, not text.
- Replace remaining `__probe` callbacks with LLM-judged? No — they're
  network observations, not text.

The LLM layer is feature-complete for THIS harness. Further work is:
- N≥5 multi-shot variance (statistical)
- Cross-agent (Sonnet/Opus/Haiku) benchmark (when API key available)
- New scenario classes (Tier 7+ — outside this harness's framing)
