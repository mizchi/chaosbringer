# Rubric calibration audit & fix (#124)

Audited the 21 FAIL verdicts across the 28-run session batch
(N=3 + N=1 untested). For each FAIL, classified whether the
agent demonstrated the criterion in evidence the rubric couldn't
see ("false negative") or genuinely skipped it ("true negative").

## Audit results

```
Total FAILs across 28 runs: 21
Overall: 12 false negatives / 21 fails (57%)

Per-criterion breakdown:
  read-target-source          3 FN /  0 TN  (100% FN)
  investigate-before-edit     5 FN /  2 TN  (71% FN)
  stated-hypothesis           4 FN /  4 TN  (50% FN)
  customer-impact-recovered   0 FN /  2 TN  (0% FN)
  fixed-the-regex             0 FN /  1 TN  (0% FN)
```

## Root cause

Two brittle regexes in `packages/aws-faults/src/wheel/scoring.ts`:

### 1. `readTargetSource` TEXT regex

```ts
const TEXT = /\btarget\/src|writeOrder|...|server\.ts|.../i;
```

Doesn't match `server.live.ts` (the eval-time variant landing pad
introduced by #121). Agents who explicitly journal
`read: server.live.ts` get marked as not having read source.

### 2. `checkedKumoChaosStats` TEXT regex

```ts
const TEXT = /\/kumo\/chaos\/(rules|stats)|chaos\s+(rule|stat|surface|config)|.../i;
```

Requires the literal substring `/kumo/chaos/rules` (with leading
slash directly after a word boundary). Agents who write `kumo
/chaos/rules empty` or `Kumo's /chaos/rules` aren't matched. Since
`investigate-before-edit` falls back to
`checkedKumoChaosStats AND readTargetSource`, a single regex miss
on the chaos pattern cascades into the investigate-before-edit
FAIL too.

## Fixes applied

`packages/aws-faults/src/wheel/scoring.ts`:

1. **`checkedKumoChaosStats` TEXT regex** — added alternation
   `\bkumo[\s'/]+\/?chaos\b` so "kumo /chaos", "kumo's chaos",
   "kumo/chaos" all match.

2. **`readTargetSource` TEXT regex** — changed `server\.ts` to
   `server\.(?:live\.)?ts` and added a list of identifier
   keywords from the catalog variants (NOTE_VALIDATION_REGEX,
   CLOCK_SKEW_MS, BOUNCER_MAX, recentRequests, logRequest,
   getTier, wrapPool, withBouncer, TIER_TTL_MS, LOG_CAP_BYTES).
   The rationale: an agent who names a specific identifier in
   their journal could only have learned it by reading the
   source.

## Simulated impact

Running both regexes (old vs new) against the 28 saved journals:

```
6 runs gain a previously-failed criterion:
  regex-n3-r1          src→PASS    (53% expected to climb significantly)
  cache-n3-r2          src→PASS    (88% expected to gain ~4pp)
  multi-svc-eval       src→PASS    (82% expected to gain ~3pp)
  schema-n3-r2         kumo→PASS   (90% expected to gain ~3pp)
  bouncer-n3-r2        kumo→PASS   (90% expected to gain ~3pp)
  pg-replica-eval      kumo→PASS   (gain depends on rubric weights)
```

The biggest beneficiary is `regex-n3-r1` — the 53% outlier from
the variance batch. Its journal explicitly says
`read: server.live.ts — found NOTE_VALIDATION_REGEX = /^(a+)+!$/`
which the new regex now matches. The agent did everything right;
the rubric just couldn't see it.

## Remaining true negatives

9 of 21 FAILs are TRUE negatives — agents who reached the
canonical mitigation but legitimately did NOT journal the
investigation step. For these:

- `investigate-before-edit (TN)`: agent jumped from page-hint to
  edit without recording any intermediate reads. The mitigation
  was correct (often from prior pattern recognition) but the
  process didn't include a documented investigation step.
- `stated-hypothesis (TN)`: agent acted without an explicit
  "I think X because Y" statement. Diagnostic intuition,
  not articulated reasoning.

These aren't bugs in the rubric; they're real process gaps the
rubric is designed to flag. The brief encourages explicit
journaling, and the LLM judge is responsibly catching cases
where the brief wasn't followed.

## What we did NOT change

- **LLM judge prompts** stay as-is. They're already permissive
  ("Even brief one-line statements count"). Sample LLM-judge
  outputs from the audit showed the LLM is generally calibrated
  well; the false-negative rate is driven by the regex-based
  fallback / cross-criterion AND-gates, not the LLM itself.
- **The `investigate-before-edit` AND-gate** (chaos-stats AND
  source-read for the fallback) stays. It's load-bearing for the
  rubric's process emphasis; loosening it would let agents
  bypass both checks at once.

## Follow-up

After the next eval batch, re-run this audit script. If the
false-negative rate stays >30%, dig deeper into the LLM judge
prompts. If it drops to <20%, the rubric is calibrated.

Audit script: `/tmp/audit.py` (not checked in — one-off).
