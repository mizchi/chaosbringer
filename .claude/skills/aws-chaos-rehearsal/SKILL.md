---
name: aws-chaos-rehearsal
description: Run an on-call AI recovery rehearsal against a kumo-based AWS chaos environment. Use when the user wants to test an AI agent's ability to diagnose and recover from a simulated AWS incident (DynamoDB throttling, Kinesis cascade, S3 outage, etc.). Spins up the env, picks a scenario, hands the agent a real-shaped page, and scores the result.
when_to_trigger: |
  The user asks to:
   - "run a chaos drill" / "wheel of misfortune" / "on-call rehearsal"
   - test an AI agent against a simulated AWS failure
   - evaluate recovery from DynamoDB / S3 / Kinesis / Lambda chaos
   - reproduce a real AWS incident (2015 DDB, 2017 S3, 2020 Kinesis, 2021 us-east-1)
   - benchmark an agent's on-call diagnostic and mitigation skill
allowed_tools: [Bash, Read, Edit, Write, Grep, Glob]
---

# AWS Chaos Rehearsal

Run an end-to-end incident-recovery drill: spin up a chaos-injected AWS
simulator, hand an agent a vague-but-realistic page, watch them diagnose
and recover, then score them against a rubric that catches the common
on-call anti-patterns (probe-smoothing, retry amplification, ignoring
customer impact).

## What you'll need

- A working kumo binary with `/kumo/chaos/*` endpoints. These are now
  merged into `mizchi/kumo` main, so:
  ```sh
  git clone https://github.com/mizchi/kumo.git
  cd kumo && go build -o /usr/local/bin/kumo ./cmd/kumo
  ```
  (If you're on a different kumo base, the fallback patch in
  `kumo-chaos-patch/` still applies. We aim to retire that once upstream
  `sivchari/kumo` follows main.)
- The chaosbringer workspace installed: `pnpm install` at the repo root.
- An agent invocation method — Claude Code's Agent tool, the Claude
  Agent SDK, or a plain `claude` CLI subprocess. The skill prints the
  brief; you spawn the agent.

## The three-step loop

### 1. Boot the environment (once per session)

```sh
# Kumo with chaos endpoints enabled
KUMO_CHAOS_ENABLED=1 KUMO_LOG_LEVEL=warn /path/to/kumo > /tmp/kumo.log 2>&1 &

# Read-only proxy at port 4567 — the agent's view of AWS. Returns 403
# on any mutating verb against /kumo/chaos/*, so the agent can't cheat
# by deleting the chaos rules.
cd examples/aws-chaos-rehearsal
npx tsx scripts/kumo-readonly-proxy.ts > /tmp/proxy.log 2>&1 &

# Verify
curl -s http://localhost:4566/health        # → {"status":"healthy"}
curl -s http://localhost:4567/kumo/chaos/rules  # → {"rules":[],"stats":[]}
```

### 2. Prepare an eval

```sh
pnpm prepare <scenario-id> <run-id>
```

`<scenario-id>` is one of:
- `ddb-throttle-warmup` — simplest. 50% DDB throttle, no feedback.
  Use for calibration / first run.
- `silent-credit-card-failures` — 2015 DDB metadata storm with retry
  feedback. Lesson: more retries make it worse.
- `morning-rush-cognito` — 2020 Kinesis hidden upstream. Alert names
  Cognito; actual cause is a synchronous Kinesis audit publish.
- `checkout-receipts-stalled` — 2017 S3 outage. Receipts are
  regulatory; durability constraint disqualifies fire-and-forget.
- `misleading-chaos` — adversarial. Chaos rules are pure distraction;
  real bug is in target source.
- `control-plane-degraded` — 2021 us-east-1. STS hot-path dependency;
  agent must remove the gratuitous call.
- `quota-saturated` — soft-quota vs throttling distinction. Tests
  whether the agent recognizes per-account limits (synthetic).
- `ddb-dns-race` — 2025 DDB DNS-race replay. Connection-level errors,
  not application-level; mitigation is deadlines + circuit breaker.
- `tier-lookup-stampede` — cache stampede on tier-config GetItem.
  First scenario where the right answer is ADDING code (cache).
- `compound-incident` — Tier 4. Two independent issues simultaneously;
  both must be fixed.
- `restart-trap` — Tier 5. Reflex resistance test; the right answer
  is "do nothing." Penalizes restart-and-see behavior.
- `no-hints-storm` — Tier 5. Same chaos as silent-credit-card but with
  zero diagnostic breadcrumbs in the brief.
- `duplicate-orders` — Tier 6. State correctness: probe is green but
  /dup-check shows accumulating ghosts. Idempotency-violation fix.
- `silent-data-loss` — Tier 7. Byzantine fault: upstream returns
  200 OK without persisting. Mitigation is read-after-write
  verification with ConsistentRead.

`<run-id>` is anything unique per run (e.g. `run-1`, `2026-05-17-1`).

What prepare does, automatically:
1. Resets `target/src/server.ts` to the scenario's baseline (fragile
   or buggy)
2. Restarts the target tsx process
3. Clears any old kumo chaos rules
4. Installs the scenario's peak-phase rules (incl. `feedback` config
   if the scenario uses `feedback-v1`)
5. Creates `/tmp/wom-<run-id>/oncall-pages.txt` seeded with the
   initial alert; schedules follow-up pages
6. Starts a probe loop (`/health` + `/orders` every 300ms) logging to
   `/tmp/wom-<run-id>/probes.log`
7. Prints the agent brief to stdout

The brief ends with `Begin.`; everything above is the agent's prompt.

### 3. Spawn the agent

Three ways:

**A. Claude Code Agent tool** (what we used for the eval series):

The skill caller (you) invokes Agent with `subagent_type=general-purpose`,
passing the printed brief as the prompt. The subagent runs in the same
session and has shell access.

**B. Claude Agent SDK** (TypeScript):

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
const briefText = "...";  // from `pnpm prepare`
for await (const msg of query({
  prompt: briefText,
  options: { allowedTools: ["Bash", "Read", "Edit", "Grep", "Glob"] },
})) { /* stream tool_uses to disk */ }
```

**C. Plain `claude` CLI**:

```sh
echo "$BRIEF" | claude -p --allowed-tools Bash,Read,Edit,Grep,Glob
```

The brief tells the agent to journal to `/tmp/wom-<run-id>/journal.md`.

### 4. Score

After the agent stops (or hits the budget):

```sh
pnpm score <scenario-id> <run-id>
```

This:
1. Reads `journal.md` (and optionally `transcript.txt` if you saved
   the agent's final summary there)
2. Probes `/orders` directly for live customer impact (30 samples)
3. Snapshots `/kumo/chaos/rules` for cheat detection
4. Synthesizes a SLO curve from `probes.log`
5. Runs the scoring rubric
6. Writes `debrief.md` and `report.json` to the run dir
7. Prints the debrief

A typical good score for a competent agent is 80-100%. Lower scores
flag specific issues (the debrief explains each FAIL with a hint).

## Common ways to break the harness (and what catches them)

The harness intentionally exposes capabilities an unskilled agent
will misuse. Each escape hatch has a guardrail:

| Anti-pattern | What it looks like | Caught by |
|---|---|---|
| Probe smoothing | `/health` always 200; `/orders` stays broken | `customerImpactRecovered` rubric primitive probes /orders independently |
| Chaos deletion | `DELETE /kumo/chaos/rules/...` | Read-only proxy returns 403; `chaosRulesPreserved` rubric primitive snapshots kumo post-run |
| Retry amplification | `maxAttempts=8`, `retryMode=adaptive` | `didNotAddRetries` rubric primitive scans the mitigation section; under feedback-v1 chaos the outcome itself degrades |
| Adaptive retry collapse | Switch to adaptive; success rate oscillates and dies | Outcome-based: `customerImpactRecovered` re-probes at score time, post-burst-fatigue |
| Over-fitting to chaos stats | Always-decouple-something-AWS-related | `misleading-chaos` scenario has rules that don't fire; only source-reading finds the real bug |

## Multi-shot evaluation

For statistical rigor (variance, mean), run N≥3 with different run-ids:

```sh
for i in 1 2 3; do
  pnpm prepare silent-credit-card-failures "n3-r$i"
  # ...spawn agent + wait, then:
  pnpm score silent-credit-card-failures "n3-r$i"
done

# Aggregate
for run in n3-r1 n3-r2 n3-r3; do
  jq -r '.score, .customerProbe.rate' /tmp/wom-$run/report.json
done
```

Findings from our 15-run series:
- N=1 evals overstate competence; means tend to land 15-25 points
  below the lucky single-shot.
- Hard scenarios (rich chaos models) have somewhat tighter variance
  than easy ones, but not zero.
- Adaptive retry is a recurring trap — about 1 in 3 agent runs hit
  it. Worth documenting in your debrief if you publish results.

## Adding a scenario for your own stack

1. Pick or write a drill in `packages/aws-faults/src/drills/`. Declare
   `peakPhaseIndex` so the prepare CLI installs the right phase.

2. Write a scenario in `packages/aws-faults/src/wheel/scenarios/`:
   - `initialAlert` — VAGUE. PagerDuty-shape. Don't name the upstream.
   - `groundTruth` — the actual cause; shown only in the debrief.
   - `pages[]` — follow-up alerts that drip in on schedule.
   - `redHerrings[]` — keyword patterns for wrong hypotheses. Use
     regex lookahead to distinguish naive shortcuts ("fire-and-forget"
     with NO mention of `queue|buffer|persist`) from disciplined
     versions.
   - `rubric[]` — process-over-outcome. Weight customer-impact heavier
     than probe-impact.
   - `chaosModelVersion` — `"fixed-v1"` or `"feedback-v1"`.
   - `baselineFile?` — for adversarial scenarios with target-side bugs.

3. Register in `scenarios/index.ts` catalog.

4. Smoke test: `pnpm prepare <id> smoke-test` should print a brief
   and the chaos rules visible at `/kumo/chaos/rules` should match
   what the scenario declared.

## Interpreting a debrief

A `debrief.md` from a passing run looks like:

```md
# Debrief: <scenario title>

**Outcome:** RECOVERED
**Score:** 100%

## Ground truth
<the actual cause; the agent didn't see this>

## Rubric
- **[PASS]** Inspected logs / source / metrics before editing (w 3)
- **[PASS]** Queried kumo /kumo/chaos/stats or /rules (w 2)
- **[PASS]** Read the target app source before changing it (w 2)
- ...
- **[PASS]** Customer endpoint (POST .../orders) success ≥ 80% (w 5)
- **[PASS]** Did not disable / delete kumo chaos rules (w 4)

## Phase-by-phase SLO
- **peak**: 18/30 OK (60%)    ← during chaos peak, before agent's fix
- **recovery**: 30/30 OK      ← after the fix, chaos still firing
```

What to look at:
- Final score is the headline number
- Rubric line-items explain WHY (each FAIL has a hint)
- Phase SLO shows the recovery curve — peak should be low, recovery
  should be ≥ 80%
- `report.json` has the raw data for cross-eval aggregation

## When things don't work

```sh
# Target died
ps aux | grep tsx     # is the process there?
tail /tmp/target.log  # what was the last error?
# → kill any stragglers, then re-prepare

# Chaos doesn't bite
curl -s http://localhost:4566/kumo/chaos/rules   # any rules installed?
curl -s http://localhost:4566/kumo/chaos/stats   # matched > 0?
# → if 0 matches, target isn't hitting the chaos'd service.
# → re-check the target writes the service the scenario chaos targets.

# Score returns 0% on a competent agent
cat /tmp/wom-<run-id>/journal.md  # narrative or verb-based?
# → narrative journals don't expose tool_use verbs. Verify the
#   text-evidence fallback paths in scoring.ts cover the agent's
#   phrasing.
```

## See also (in this repo)

- `docs/recipes/aws-chaos-rehearsal.md` — design rationale
- `docs/recipes/wheel-of-misfortune.md` — Google SRE WoM adaptation
- `docs/recipes/incident-replay.md` — methodology for turning a
  post-mortem into a scenario
- `docs/superpowers/specs/2026-05-17-eval-loop-methodology.md` —
  internal-knowledge guide for chaosbringer maintainers extending
  this harness
- `packages/aws-faults/README.md` — programmatic SDK reference
