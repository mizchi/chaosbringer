# aws-chaos-rehearsal

End-to-end demo of the AI recovery rehearsal flow. 22 scenarios across
9 capability tiers, three storage protocols, three fault layers.

**For the canonical run-it-yourself guide see
[`docs/cookbook/aws-chaos-rehearsal-quickstart.md`](../../docs/cookbook/aws-chaos-rehearsal-quickstart.md).**
This README is the in-tree reference; the quickstart is the
copy-pastable getting-started doc.

## Quick start

```sh
# From the chaosbringer workspace root.
pnpm install
./examples/aws-chaos-rehearsal/scripts/bootstrap.sh   # idempotent, ~15s

cd examples/aws-chaos-rehearsal
pnpm prepare silent-data-loss my-run-1
# → prints the agent brief; paste into your model or use a sweep driver
pnpm score silent-data-loss my-run-1
```

For cross-agent comparison:
```sh
pnpm sweep --driver "bash scripts/drivers/claude-code-driver.sh" \
           --scenarios silent-data-loss,duplicate-orders \
           --driver-label claude-opus-4-7
```

## Prerequisites

`bootstrap.sh` handles all of these if it can. Manual:

- **Node 22+** with `pnpm`
- **Go 1.21+** to build kumo (cloned from `mizchi/kumo` main)
- **PostgreSQL 14+** for the pg-* scenarios (skippable with `--no-postgres`)
- **Playwright + Chromium** for journey-based customer probe
- An agent / model — Claude Code CLI, OpenAI, your own — see
  [scripts/drivers/README.md](scripts/drivers/README.md)

> **kumo upstream.** Chaos endpoints live in `mizchi/kumo` main and
> will be upstreamed to `sivchari/kumo` when ready. Until then the
> standalone patch at [`../../kumo-chaos-patch/`](../../kumo-chaos-patch)
> is the fallback for non-mizchi bases.

## Run a drill manually (no AI)

```sh
pnpm -F aws-chaos-rehearsal-example drill
```

You'll see `[baseline]` samples succeed, then `[injected]` samples fail at ~50%, then `[recovery]`
samples stay broken (the target has no mitigations) — drill reports `recovered: false`. That is
the baseline failure mode.

## Run the AI rehearsal

```sh
ANTHROPIC_API_KEY=… pnpm -F aws-chaos-rehearsal-example rehearsal
```

What happens:

| Phase | What you see | What the agent sees |
|---|---|---|
| baseline | 5s of `[baseline] ok` samples | (nothing yet) |
| injected | 5s of `[injected] FAIL ...` showing impact | the agent is spawned with the drill brief; reads `target/src/server.ts`, tails `/tmp/target.log`, queries `kumo/chaos/stats` |
| recovery | continuous probes | the agent patches the target (e.g. caps SDK retries, adds a circuit breaker), restarts it, the orchestrator notices SLO climbing back |

The drill **does not clear the chaos rules** during the recovery phase. The agent cannot "wait it
out" — a real mitigation must absorb the fault.

## Layout

```
examples/aws-chaos-rehearsal/
├── target/
│   └── src/server.ts        # Hono app, intentionally fragile
│   └── src/ui.ts            # minimal SPA so chaosbringer journeys have something to drive
├── kumo/
│   └── latency-baseline.json  # #667 startup latency profile
├── recipes/                 # chaosbringer customer-impact journeys (per-scenario)
│   └── silent-data-loss/    # the journey catches Byzantine writes the curl probe misses
└── scripts/
    ├── _boot.ts             # spawn kumo + target, wait ready
    ├── run-drill.ts         # manual drill (no AI)
    └── run-ai-rehearsal.ts  # full loop with Claude Agent SDK
```

### Customer-impact probe (issue #114)

`eval-score.ts` measures customer impact two ways:

- **Journey** (preferred) — if `recipes/<scenario-id>/` exists, runs N
  virtual users through verified chaosbringer recipes against the
  target's SPA. Catches silent-data-loss / duplicate-write / stale-read
  failures that the curl probe is blind to.
- **Curl** (fallback) — `POST /orders × 30`. Used when a scenario
  has no recipe library yet.

Mode appears in `report.json.customerProbe.mode` and the scoring stdout.

### Replay-based regression gate (issue #117)

Checked-in fixture runs under `fixtures/<name>/` let CI catch rubric
regressions without hitting any live env:

```sh
pnpm replay silent-data-loss-baseline
pnpm replay silent-data-loss-baseline --tolerance=0.05
```

Each fixture contains `journal.md`, `probes.log`, `_replay-inputs.json`
(captured customer probe + chaos snapshot), `llm-verdicts.json`
(pre-recorded judge outcomes so the replay is offline), and
`expected.json`. The CI workflow at
`.github/workflows/aws-chaos-rehearsal-replay.yml` runs these on
every PR that touches `packages/aws-faults/` or this example.

## What this is and isn't

**Is**: a rehearsal harness. The point is to measure whether an AI can take a real, running,
breaking system and restore SLO under pressure. Each drill is a question: "given THIS failure,
THIS amount of time, and THIS tool surface, does the agent figure it out?"

**Isn't**: a fault library for production. The chaos endpoints live in a patched kumo running on
your laptop. Don't point an AWS SDK at this and expect anything useful in prod.

## Next drills to add

Skeletons live in `packages/aws-faults/src/drills/`. Wanted next:

- `s3EventualConsistency` — `NoSuchKey` returned probabilistically right after `PutObject`. Tests
  whether the agent adds a wait-with-jitter / consistent-read path.
- `sqsReceiveDisconnect` — connection hangup mid-`ReceiveMessage`. Tests visibility-timeout reasoning.
- `lambdaInvoke503Spike` — synchronous Lambda invoke returns 503 in bursts. Tests bulkhead reasoning.
- `kmsDecryptTailLatency` — KMS p99 jumps to 8s. Composes with #667 latency rather than chaos errors.

See [`docs/recipes/aws-chaos-rehearsal.md`](../../docs/recipes/aws-chaos-rehearsal.md) for the full design rationale.
