# @mizchi/aws-faults

Runtime AWS fault injection for [kumo](https://github.com/sivchari/kumo) + a drill SDK for AI recovery rehearsal.

Pairs with the Go-side patch in [`kumo-chaos-patch/`](../../kumo-chaos-patch) that adds `/kumo/chaos/*`
admin endpoints to kumo. With the patch applied, this package gives you:

1. A thin TypeScript client (`kumoChaos`) that talks to those endpoints.
2. A drill SDK (`runDrill`) that injects, observes, and waits for recovery.
3. A library of pre-built drills (currently: `ddbThrottleStorm`).

The point is not "another chaos library." It is **recovery rehearsal**: install a fault, hand
the broken environment to a recovery agent (a human or AI), watch whether SLO returns to baseline
while the fault is still being injected. The runtime API exists because rehearsal demands runtime
control — you can't `KUMO_LATENCY_CONFIG`-restart between drills.

## How it relates to kumo PR #667

[PR #667](https://github.com/sivchari/kumo/pull/667) adds a **startup-loaded** latency emulator —
the right shape for baseline latency in CI but not for chaos drills, where rules must mutate at
runtime. This package layers on top of #667:

- **Baseline latency** (#667): `KUMO_LATENCY_CONFIG=./latency.json kumo` — every run sees the same
  shaped tail latency.
- **Runtime chaos** (this package): drills install/remove rules during the run, e.g. "spike DDB
  throttling for 60s, then watch the AI fix it."

Both can be active at once; chaos rules compose with latency rules.

## 60-second tour

```ts
import { kumoChaos, runDrill } from "@mizchi/aws-faults";
import { ddbThrottleStorm } from "@mizchi/aws-faults/drills";

const chaos = kumoChaos({ endpoint: "http://localhost:4566" });

const report = await runDrill({
  chaos,
  drill: ddbThrottleStorm({
    probeUrl: "http://localhost:3000/health",
    probability: 0.5,
  }),
  baselineMs: 5_000,
  recoveryTimeoutMs: 60_000,
});

console.log(report.passed ? "RECOVERED" : "TIMEOUT", report);
```

## Building a custom drill

A drill is "rules + health check + acceptance criteria":

```ts
import type { Drill } from "@mizchi/aws-faults";

export const myDrill: Drill = {
  id: "s3-eventual-consistency",
  name: "S3 read-after-write returns NoSuchKey",
  description: "GET immediately after PUT fails 30% of the time.",
  rules: [
    {
      id: "s3-eventual",
      enabled: true,
      match: { service: "s3", action: "GetObject" },
      inject: {
        kind: "awsError",
        probability: 0.3,
        awsError: { code: "NoSuchKey", httpStatus: 404 },
      },
    },
  ],
  healthCheck: async () => {
    const t0 = performance.now();
    const res = await fetch("http://localhost:3000/health", { method: "POST" });
    return {
      ok: res.ok,
      latencyMs: performance.now() - t0,
      errorRate: res.ok ? 0 : 1,
    };
  },
  acceptance: { p99Ms: 1000, errorRate: 0.01, consecutiveGreen: 5 },
  brief: "...markdown brief for the AI agent...",
};
```

## API

### `kumoChaos({ endpoint? })`

| Method | Behavior |
|---|---|
| `upsertRule(rule)` | Add or replace a rule by id. |
| `deleteRule(id)` | Remove one rule. |
| `clearRules()` | Remove all rules. |
| `listRules()` | Returns `{ rules, stats }`. |
| `stats()` | Per-rule injection counters. |
| `installProfile(rules[])` | Atomic-ish replace: clear then install. |

### `runDrill({ chaos, drill, ... })`

Three-phase flow:

1. **baseline** — `baselineMs` of probes with no chaos installed.
2. **injected** — installs the drill's rules, samples again to confirm impact.
3. **recovery** — keeps probing until either acceptance is met for `consecutiveGreen`
   samples in a row, or `recoveryTimeoutMs` elapses. The caller (a human or an AI
   agent) is expected to act on the target during this phase.

Chaos rules are cleared on exit regardless of outcome.

## See also

- [`examples/aws-chaos-rehearsal/`](../../examples/aws-chaos-rehearsal) — end-to-end demo with a
  target Hono app and the Claude Agent SDK driving recovery.
