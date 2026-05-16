# AWS chaos rehearsal — design rationale

This recipe explains *why* this layer exists separately from `chaosbringer` and `@mizchi/server-faults`,
and how it composes with [sivchari/kumo](https://github.com/sivchari/kumo).

## The gap this fills

| Layer | Tool | Covers |
|---|---|---|
| Browser → network | `chaosbringer` faults.* | HTTP between browser and app server |
| Inside app server | `@mizchi/server-faults` | App handler latency / 5xx / abort |
| **App → AWS** | `@mizchi/aws-faults` + patched kumo | **AWS-side faults: throttling, eventual consistency, disconnect, tail latency** |

`@mizchi/server-faults` can inject 5xx and latency at the app boundary, but it doesn't speak AWS
protocols — it can't return a `ProvisionedThroughputExceededException` with the right JSON envelope
that an AWS SDK retry loop recognizes. That fault has to live in something that *is* AWS — and that
is kumo.

## Why not just use kumo's existing latency emulator (#667)?

PR #667 is startup-loaded by design — `KUMO_LATENCY_CONFIG=foo.json kumo`, and the rules are
immutable for the process's lifetime. That's the right shape for **CI baseline latency** (every
test sees the same shaped tail). It is the wrong shape for **drills**, where the experiment is:

> Install fault → observe impact → let the recovery agent act → check whether SLO returns →
> uninstall fault → install a *different* fault → repeat.

A drill can have N rules across M scenarios in a single run. Restarting kumo between each is
too slow and loses the in-memory state of every running service. So we layer a sibling
`internal/chaos` package onto kumo, with the same matcher shape (so rules port between latency
and chaos with no rewrite) but a runtime API.

The two layers compose: latency rules from #667 set the baseline tail, chaos rules from this
package overlay throttling / errors / disconnects on top.

## Why "AI recovery rehearsal" specifically?

Three things make recovery rehearsal a useful target:

1. **It's the part of an outage humans are worst at.** Detection has dashboards. Mitigation
   knowledge is in runbooks. The actual loop — "I see a failure, what do I change, did it work?"
   — is the bottleneck under stress.
2. **It's a tight, measurable loop.** A drill has a clear acceptance criterion (probe SLO returns
   to baseline for N samples in a row, while chaos is still active). Either the agent fixes it or
   it doesn't.
3. **Production-grade outages are nearly impossible to rehearse safely.** kumo gives you a real
   AWS-shaped failure mode without paying real-AWS blast-radius costs.

The rehearsal harness intentionally:

- **Does not clear chaos rules during recovery.** "Wait it out" is the easiest failure mode for an
  agent to fall into. The fault stays on until either the agent absorbs it or the timeout fires.
- **Gives the agent shell access to the target source.** Real outages get fixed by code changes
  (retry caps, circuit breakers, queueing). Restricting the agent to runbook actions would test
  runbook-following, not recovery.
- **Streams the agent's tool-use events to stderr.** Watching the agent decide is the most
  valuable part of the rehearsal for the human reviewer.

## What an end-to-end run looks like

```
[baseline] ok    latency=42ms   err=0.00
[baseline] ok    latency=51ms   err=0.00
...
[injected] FAIL  latency=2104ms err=1.00      <- chaos rules installed
[injected] FAIL  latency=5230ms err=1.00
[agent.tool] Bash                              <- agent spawned
[agent] Investigating: kumo chaos stats show DDB throttling at 50%
[agent.tool] Read    target/src/server.ts
[agent.tool] Edit    target/src/server.ts     <- caps retries to 1
[agent.tool] Bash                              <- restarts target
[recovery] FAIL  latency=1800ms err=1.00
[recovery] ok    latency=85ms   err=0.00      <- mitigation working
[recovery] ok    latency=68ms   err=0.00
...
recovered: true
```

The point is the SLO trace, not the agent transcript. A good drill produces a clear "before /
during / after" curve that you can put on a slide.

## Where the seams are

If you want to plug in your own:

- **Probe**: implement `Drill.healthCheck` returning `{ ok, latencyMs, errorRate, detail? }`.
- **Fault**: write a kumo chaos rule (any combination of `latency` / `disconnect` / `awsError` /
  `throttle`) and add it to `Drill.rules`.
- **Acceptance**: tune `Drill.acceptance` (p99, error rate, consecutive-green count).
- **Brief**: rewrite `Drill.brief` — this is the markdown text the AI agent reads first. Be
  specific about what hints you want to give and what's deliberately omitted.

The harness itself is intentionally thin. Don't put policy here; put it in drills.
