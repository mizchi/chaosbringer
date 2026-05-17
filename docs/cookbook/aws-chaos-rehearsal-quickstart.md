# Run an AI on-call recovery drill

Three commands. Picks a real-incident scenario, hands an agent a vague
PagerDuty-shaped page, scores the result.

## Prerequisites

```sh
# 1. Apply the chaos patch to a kumo fork (see kumo-chaos-patch/README.md)
/path/to/chaosbringer/kumo-chaos-patch/apply.sh /path/to/kumo-fork
go build -o ~/bin/kumo ./cmd/kumo                   # in the kumo dir

# 2. Install workspace
pnpm install                                         # in chaosbringer root
```

## Boot the env (once per session)

```sh
KUMO_CHAOS_ENABLED=1 ~/bin/kumo > /tmp/kumo.log 2>&1 &
cd examples/aws-chaos-rehearsal
npx tsx scripts/kumo-readonly-proxy.ts > /tmp/proxy.log 2>&1 &
```

The proxy on port 4567 is the agent's "AWS Health Dashboard." It
returns 403 on any mutating verb against `/kumo/chaos/*` so the agent
can't fix the test by deleting the chaos.

## Run a single drill

```sh
# Pick a scenario id:
pnpm prepare silent-credit-card-failures my-run-1
# → prints the agent brief; resets target, installs chaos, starts probes
```

Available scenarios:

| id | Replays | Lesson |
|---|---|---|
| `ddb-throttle-warmup` | (simple) | calibration / smoke test |
| `silent-credit-card-failures` | 2015 DDB | retry storms amplify under feedback |
| `morning-rush-cognito` | 2020 Kinesis | hidden upstream dependency |
| `checkout-receipts-stalled` | 2017 S3 | durability constraint disqualifies fire-and-forget |
| `misleading-chaos` | adversarial | chaos isn't always the cause |

Spawn an agent (Claude Code Agent tool / Claude Agent SDK / `claude -p`)
with the printed brief as prompt. The brief tells the agent to journal
to `/tmp/wom-my-run-1/journal.md`. The agent investigates, edits
`target/src/server.ts`, restarts the target, verifies.

When the agent stops:

```sh
pnpm score silent-credit-card-failures my-run-1
# → reads journal + probes /orders + snapshots kumo + runs rubric
# → writes /tmp/wom-my-run-1/{debrief.md, report.json}
```

A typical good run scores 80-100%. The debrief explains each rubric
line item (PASS/FAIL with a hint).

## Multi-shot for variance

```sh
for i in 1 2 3; do
  pnpm prepare silent-credit-card-failures "n3-r$i"
  # spawn agent...
  pnpm score silent-credit-card-failures "n3-r$i"
done

# Aggregate
for run in n3-r1 n3-r2 n3-r3; do
  jq '.score, .customerProbe.rate' /tmp/wom-$run/report.json
done
```

A single N=1 run is a sample, not a measurement. Our reference series
(15 runs documented in `docs/recipes/evaluation-2026-05-17-*.md`)
found N=1 scores can be 20+ points off the N=3 mean.

## What's actually being scored

The rubric is process-over-outcome:

- `investigatedBeforeEditing` — read source / chaos / pages first
- `checkedKumoChaosStats` — query /kumo/chaos/* to identify upstream
- `readTargetSource` — read the target's code path before changing it
- `statedHypothesis` — explicit reasoning before action
- `didNotAddRetries` — did NOT increase retry attempts (2015 anti-pattern)
- `minimalCodeChange` — focused intervention, not a rewrite
- `recoveredSlo` — probe SLO returned to threshold
- `customerImpactRecovered` — separate post-run probe of /orders
  confirms it; catches "probe smoothed, customer broken"
- `chaosRulesPreserved` — agent did not delete the simulated chaos to
  force recovery

Different scenarios weight these differently. See
`packages/aws-faults/src/wheel/scenarios/<id>.ts`.

## When to use the Claude Code skill version

The `.claude/skills/aws-chaos-rehearsal/SKILL.md` packages this same
workflow as an invocable skill. Triggers on prompts like "run a chaos
drill" / "wheel of misfortune" / "test recovery." Used inside a Claude
Code session it picks a scenario, runs prepare, spawns the agent via
the Agent tool, and runs score — all in one chat turn.

## Going deeper

- `docs/recipes/aws-chaos-rehearsal.md` — design rationale
- `docs/recipes/wheel-of-misfortune.md` — Google SRE WoM adaptation
- `docs/recipes/incident-replay.md` — turn a post-mortem into a scenario
- `docs/superpowers/specs/2026-05-17-eval-loop-methodology.md` —
  internal-knowledge: how we built and tested this across 15 runs
- `packages/aws-faults/README.md` — programmatic SDK reference
