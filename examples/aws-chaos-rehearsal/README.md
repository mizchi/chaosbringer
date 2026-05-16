# aws-chaos-rehearsal

End-to-end demo of the AI recovery rehearsal flow:

1. Boot a patched [kumo](https://github.com/sivchari/kumo) with `/kumo/chaos/*` runtime endpoints + the
   #667 latency baseline (`kumo/latency-baseline.json`).
2. Boot a deliberately-fragile Hono target that writes orders to DynamoDB-via-kumo
   (`target/src/server.ts` — search for "INTENTIONAL WEAKNESS").
3. Run a drill (currently: `ddbThrottleStorm`) that installs runtime chaos rules.
4. Hand the broken environment to a Claude Agent SDK session and watch whether SLO recovers
   while chaos is still being injected.

## Prerequisites

You need a `kumo` binary built **with the patch in `../../kumo-chaos-patch` applied**. The boot
script checks for the `/kumo/chaos/rules` endpoint at startup and aborts if it's missing — without
that endpoint, drills have no runtime control surface.

```sh
# in a kumo fork checkout
cp -r path/to/chaosbringer/kumo-chaos-patch/internal/chaos internal/
cp path/to/chaosbringer/kumo-chaos-patch/internal/server/chaos_*.go internal/server/
# apply the 3 in-place edits documented in kumo-chaos-patch/README.md
go build -o /usr/local/bin/kumo ./cmd/kumo
```

You also need:
- `pnpm install` in the chaosbringer workspace root
- `ANTHROPIC_API_KEY` exported (for the AI rehearsal script)

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
├── kumo/
│   └── latency-baseline.json  # #667 startup latency profile
└── scripts/
    ├── _boot.ts             # spawn kumo + target, wait ready
    ├── run-drill.ts         # manual drill (no AI)
    └── run-ai-rehearsal.ts  # full loop with Claude Agent SDK
```

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
