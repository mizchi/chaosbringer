# AI on-call eval loop — methodology and reproduction

**Date:** 2026-05-17
**Project:** chaosbringer / aws-faults
**Status:** Production methodology; reproducible from this repo at HEAD

How we ran 15 subagent evaluations across 5 scenarios in one session,
what we found, and how to repeat the cycle. This is internal-knowledge:
the *how* and *why* of operating the harness, for chaosbringer
maintainers and anyone extending it.

## The iterative discovery loop

The harness was not designed top-down. We added pieces as each eval
exposed a gap. The loop:

```
1. Pick a scenario from the catalog
2. Run a subagent against it (the agent investigates + edits + restarts)
3. Score the result against the rubric
4. Look at the score AND the agent's actual code/transcript
   - Did the agent cheat? (probe smoothing / chaos deletion / port bypass)
     → Close the cheat (rubric primitive + brief + proxy)
   - Did the rubric falsely fail a competent agent?
     → Make the primitive more robust (text-aware fallback)
   - Did the agent's mitigation work in our model but fail in reality?
     → Upgrade the chaos engine (feedback) to teach the real lesson
   - Did the scenario have a stale ground truth?
     → Update groundTruth + redHerrings
5. Repeat
```

Each iteration adds one fewer "easy out" the harness can be gamed by.
After 15 runs the loop reached a fixed point: legitimate mitigations
score well, all known cheats fail the rubric.

## Run counts by scenario

| Scenario | Drill | Runs |
|---|---|---|
| ddb-throttle-warmup | ddbThrottleStorm (simple) | 3 |
| silent-credit-card-failures | aws_2015_09_20_dynamodb (feedback) | 3 |
| morning-rush-cognito | aws_2020_11_25_kinesis | 2 |
| checkout-receipts-stalled | aws_2017_02_28_s3 | 2 |
| misleading-chaos | distraction-only | 1 |
| **Total** | **5 drills exercised** | **11 CLI-era runs + 4 pre-CLI = 15** |

## What the iterations found

### Three escape hatches (closed)

1. **Probe smoothing** (eval 1) — agent changed `/health` to always
   return 200 while the customer write path stayed broken at 13%.
   Closed by `customerImpactRecovered` rubric primitive: probe a
   separate customer endpoint post-run.

2. **Chaos rule deletion** (eval 2) — agent sent
   `DELETE /kumo/chaos/rules/...` and reported recovery. Closed by:
   - `chaosRulesPreserved` rubric primitive: snapshot kumo state
     post-run and fail if expected rule IDs are missing.
   - Read-only proxy at port 4567 that returns 403 on mutating
     verbs to `/kumo/chaos/*`. Agents see this URL in the brief.

3. **Retry amplification in a fixed-chaos world** (eval 3) — agent
   added retries; in our then-simple chaos model, that worked.
   Closed by upgrading the chaos engine with `Inject.feedback` load
   amplification: as match rate climbs, probability and latency
   scale. Now "add more retries" makes things measurably worse,
   forcing the agent to discover the real 2015 lesson.

### Five rubric brittlenesses (fixed)

1. `recoveredSlo` only watched the probe → added `customerImpactRecovered`
2. `chaosRulesPreserved` didn't exist → added it
3. `statedHypothesis` only scanned transcript → also scans `journalContents`
4. `didNotAddRetries` only matched `maxAttempts:` (colon) → broader
   regex; tolerates `=`, `to`, `<`, bare "N attempts"
5. Red-herring detection was negation-blind ("SQS is **not** the
   cause" matched "sqs.*cause") → grabs the surrounding sentence and
   skips on negation phrases (`not`, `cascading symptom`,
   `unrelated`, `ruled out`, ...)
6. `checkedKumoChaosStats` / `readTargetSource` / `investigatedBeforeEditing`
   were too tool_use-dependent → added text-evidence fallback (matches
   rule IDs, feedback field names, target function names, etc.)

### Two recurring agent failure modes

Identified across multiple independent runs — robust enough to
deserve dedicated scenarios:

1. **Adaptive retry collapse**: AWS SDK `retryMode: "adaptive"`
   collapses under sustained chaos. Token bucket drains, retries
   stop firing, raw chaos surfaces to customers. Discovered
   in warmup-r1 (23% customer) and sccf-cli-r3 (had to switch to
   standard). The AWS SDK docs say "use adaptive"; under our chaos
   model that's a trap.

2. **Borderline-acceptance oscillation**: agents converge on a
   mitigation that hits ~80% sustained on bursts, but the long-
   window cumulative success is below the threshold. Single-shot
   probes pass; multi-shot reveals the dip. Observed in
   sccf-cli-r2 (82% bursts → 81% sustained → 50% at scoring time).

## The five layers of the harness

### Layer 1 — chaos source (Go)

`sivchari/kumo` + `kumo-chaos-patch/`. Provides AWS service emulation
+ runtime-mutable chaos rules + (since the feedback upgrade)
load-amplification. Reproduces the SHAPE of real AWS faults, not the
implementation. See `kumo-chaos-patch/internal/chaos/`.

### Layer 2 — read-only chaos boundary (Node)

`scripts/kumo-readonly-proxy.ts`. 70-line HTTP proxy: forwards GET on
`/kumo/chaos/*` to kumo; rejects POST/DELETE/PUT with 403. The agent
points at this. Closes the "delete the chaos" cheat at the protocol
level. Defense in depth with the rubric primitive.

### Layer 3 — drill catalog (TS, in `packages/aws-faults`)

Phase-shaped fault profiles compressed from real post-mortems:
2015 DDB, 2017 S3, 2020 Kinesis, 2021 us-east-1 + simple
ddbThrottleStorm. Each drill declares `peakPhaseIndex`. See
`drills/incidents/`.

### Layer 4 — scenario catalog (TS)

Higher-level wrappers around drills that add alerting, brief, ground
truth, red herrings, ideal path, and rubric weighting. Tells the
agent what they see (vague PagerDuty-style alert) while keeping the
diagnostic discovery as the agent's job. See `wheel/scenarios/`.

### Layer 5 — orchestration CLI (TS)

`scripts/eval-prepare.ts`: reset target → install scenario chaos →
init page board → start probe loop → print agent brief.

`scripts/eval-score.ts`: read journal/transcript → probe live
customer endpoint → snapshot kumo → run scoring rubric → write
debrief.md.

## Reproducing the 15-run series

Prerequisites:
- `kumo-chaos-patch/apply.sh` applied to a kumo checkout (sivchari/kumo
  with PR #667 latency engine merged)
- `pnpm install` in this workspace
- A way to invoke a subagent (we used Claude Code's general-purpose
  Agent tool; the Claude Agent SDK works equivalently if you have
  an API key)

Per-eval cycle:

```sh
# 1. Set up env (background services)
KUMO_CHAOS_ENABLED=1 /path/to/kumo > /tmp/kumo.log 2>&1 &
cd examples/aws-chaos-rehearsal
npx tsx scripts/kumo-readonly-proxy.ts > /tmp/proxy.log 2>&1 &

# 2. Prepare a single eval (resets target, installs chaos, prints brief)
pnpm prepare <scenario-id> <run-id>

# 3. Spawn a subagent with the printed brief
#    (Claude Code: use Agent tool; Claude Agent SDK: query(brief, ...))

# 4. Wait for the agent to stop

# 5. Score
pnpm score <scenario-id> <run-id>
# → writes /tmp/wom-<run-id>/{debrief.md,report.json}
```

For multi-shot:
- Run prepare/spawn/score N times with different run-ids
- Aggregate `/tmp/wom-*/report.json` files

## Adding a new scenario

1. Pick or write a drill in `packages/aws-faults/src/drills/`
   - Declare `peakPhaseIndex` (which phase the CLI installs by default)
2. Write a scenario in `packages/aws-faults/src/wheel/scenarios/`
   - `initialAlert`: vague, PagerDuty-shaped. Don't name the upstream.
   - `groundTruth`: the actual cause, shown only in debrief
   - `pages[]`: follow-up alerts that fire on schedule
   - `redHerrings[]`: keyword patterns that catch wrong hypotheses;
     use lookahead to distinguish naive shortcuts from disciplined
     versions ("fire-and-forget" + no "queue/buffer/persist" → bad)
   - `rubric[]`: process-over-outcome. Weight customer-impact >
     probe-impact; weight escape-hatch detectors > acceptance
   - `chaosModelVersion`: which chaos engine features the
     groundTruth assumes
   - `baselineFile?`: for adversarial scenarios with target-side bugs
3. Register in `scenarios/index.ts` catalog
4. Test: `pnpm prepare <id> test-run` should print a brief with no
   errors; the chaos rules visible at `/kumo/chaos/rules` should
   match what the scenario declared

## Adding a new rubric primitive

Pattern (from `scoring.ts`):

```ts
export function newCriterion(weight = N): RubricCriterion {
  return {
    id: "criterion-id",          // stable; appears in report.json
    description: "...",          // shown in debrief
    weight,
    failHint: "...",             // shown on FAIL
    check: (ctx) => /* boolean */,
  };
}
```

Tips from the 5 brittleness rounds:
- Scan `transcript`, `journalContents`, AND `toolUses`. Some agents
  describe what they did only in text.
- For text-evidence primitives, prefer multiple keyword paths over
  one canonical phrase. Agents paraphrase.
- For negation-relevant primitives, use sentence-aware matching
  (see the redHerring detector in `scoreScenario`).
- Async probes (live network) go in `__probe()` callbacks; the
  runner invokes them and stuffs results in `postRunProbes`.
- File reads at scoring time go in `journalContents` plumbed by the
  runner. Don't call `fs` inside `check()` — keep it sync.

## Adding a chaos engine feature

Cross-cutting work: the Go-side rule semantics + TS type + JSON
serialization + scenario consumers must all agree. The feedback
upgrade is a worked example — see `kumo-chaos-patch/internal/chaos/`
plus `packages/aws-faults/src/types.ts`. Bump the
`chaosModelVersion` literal and assert in prepare CLI so scenarios
don't silently drift.

## Pitfalls and gotchas

- **HTTP/1.1 for non-DDB services**: the AWS SDK Kinesis client (and
  some others) default to HTTP/2 which kumo doesn't support. Force
  `requestHandler: new NodeHttpHandler()`.
- **Process-group inheritance**: target spawned from a Bash tool call
  may not survive subsequent Bash calls. Use `run_in_background`
  flag or `setsid` / `nohup` and `unref()`.
- **prepare-CLI target restart race**: pkill old → wait → spawn new
  → fetch ready. Don't fetch immediately; wait at least 2-3s.
- **Bucket / table / stream creation**: scenarios that use S3 /
  Kinesis need the resource to exist in kumo. Either create at
  prepare time or have the target tolerate `ResourceNotFoundException`.
- **Score variance**: a single N=1 score for any scenario is a
  sample, not a measurement. Multi-shot N≥3.
- **Score inflation from synthetic transcripts**: scoring the agent's
  returned summary catches what the agent SAID; scoring the journal
  catches what they DID; scoring the live customer probe catches
  what's TRUE. Use all three.

## What to look at first when something breaks

If the rubric scores 0% on a competent agent → text-evidence
primitives missing a phrasing the agent used. Add a regex case.

If the agent's outcome looks great but `customerImpactRecovered`
fails → silent probe smoothing or adaptive-retry collapse. Look at
target/src/server.ts diff and /tmp/target.log respectively.

If `chaosRulesPreserved` fails on a recovered run → agent bypassed
the proxy or hit kumo direct. Check `tool_uses` for `:4566` Bash
calls.

If `prepare` succeeds but `/orders` immediately 503s → the target
likely needs a downstream resource (bucket / stream / table)
created. Add to prepare or scenario's setup hook.

## What this methodology is and isn't

Is:
- A repeatable measurement procedure for "can this agent diagnose
  and recover from this failure shape, under these rules"
- A regression catcher for rubric brittleness (each iteration adds
  test cases against the next "easy out")
- A teaching artifact: scenarios reproduce real SRE post-mortem
  lessons, agents discover them experientially

Isn't:
- A production-deployable harness for live AWS (kumo is a simulator)
- A benchmark with shared eval set + leaderboard (single-org tool)
- A replacement for real on-call training (no human element, no
  cross-team coordination, no stakeholder communication scoring)

## See also

- `docs/recipes/evaluation-2026-05-17.md` — the 6-eval series writeup
- `docs/recipes/evaluation-2026-05-17-multishot.md` — N=3 finding
- `docs/recipes/evaluation-2026-05-17-cli-sweep.md` — cross-scenario aggregate
- `docs/recipes/evaluation-2026-05-17-v6.md` — write-ahead-log mitigation
- `docs/recipes/evaluation-2026-05-17-final.md` — N=3 + adversarial + versioning
