# Dogfood playground

Two variants of a small Hono app, served on different ports, with intentional divergences seeded for the recently-shipped chaosbringer tools to find. Designed to drive a sub-agent improvement loop: the agent runs the tools, reads the output, proposes (or applies) fixes, re-runs, and confirms.

## Layout

| File           | Role                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `server.ts`    | The app. Same code path for v1/v2 — divergences gated on `VARIANT` env var.            |
| `paths.txt`    | Path list for `chaosbringer parity`. Comments document each seeded divergence.         |
| `loop.ts`      | Orchestrator: spawns both variants, runs the toolchain, tears down, reports exit code. |
| `BUG_LEDGER`   | (Exported from `server.ts`) the grading rubric of seeded bugs.                         |

The bug ledger is in source, not docs, because it has to stay in sync with the actual divergence branches.

## Run the loop

```bash
pnpm install
cd playground

# Full pass — both server variants up, parity + crawls + diff
pnpm loop

# Or pieces
pnpm loop parity         # parity probe only
pnpm loop chaos          # crawl v1 + v2 + diff only

# Exit code is non-zero when the loop detected something (parity
# mismatch, new clusters on v2, etc.) — drop into reports/ to see.

# CI-gate mode: flip the exit code semantics. Success means the loop
# caught EXACTLY the expected number of seeded mismatches; less is a
# regression in detection, more is a false positive. Used by the
# `playground-dogfood` workflow.
pnpm loop --expect-mismatches 10
```

Outputs land in:

- `reports/parity.json` — full parity report (status / redirect / failure / header / body / exception / perf mismatches)
- `reports/journey-*.json` — one per journey file (write-then-read, capture-by-id, tenant-isolation)
- `reports/v1.json` / `reports/v2.json` — chaosbringer crawl reports
- `artifacts/v1/` / `artifacts/v2/` — per-page failure bundles
- `artifacts/{v1,v2}/clusters/` — one representative bundle per error cluster (via `--cluster-artifacts`)

`pnpm loop` ends with a `=== summary ===` table tallying mismatches by kind across every report, so a CI gate has a single line to grep on.

## Parity check kinds

A single `chaosbringer parity` invocation can opt into any subset of:

| Flag                                | Catches                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| (always on)                         | status / redirect / one-sided failure                    |
| `--check-body`                      | byte hash differs; JSON-aware diff names which field     |
| `--check-headers <list>`            | named response headers differ (CORS / cache-control)     |
| `--check-exceptions`                | uncaught JS errors + console.error from a browser visit  |
| `--perf-delta-ms <n>`               | right slower than left by more than N ms (single-sample) |
| `--perf-ratio <n>`                  | right > left × N (composes with `--perf-delta-ms` via OR) |

Every detected kind for a probe fires — they don't shadow each other. A path with both a header drift and a body drift prints both lines (and the JSON carries `kinds: ["header","body"]`).

## Journey: multi-step + per-actor

`chaosbringer journey --steps file.json` replays a sequence with per-side cookie jars. Each step accepts:

- `method`, `path`, `body`, `headers`, `label` — standard request shape.
- `capture: [{ from: "body.id", as: "todoId" }]` — extract a value from the response and bind it as a variable on the side it ran on. `{{todoId}}` in later steps' path / body / headers is substituted before sending.
- `actor: "alice"` — per-side, per-actor cookie jar + variable bag. Lets a journey verify tenant isolation: Alice creates a doc, Bob lists his docs, Bob must not see Alice's payload.

## Exercise individual fault kinds

Every fault kind shipped by `@mizchi/server-faults` is reachable via env vars passed to either variant. Leave a var unset and that fault stays off.

| Env var                 | Maps to                                       |
| ----------------------- | --------------------------------------------- |
| `CHAOS_5XX_RATE`        | `status5xxRate` (0..1)                        |
| `CHAOS_5XX_CODE`        | `status5xxCode` (500 / 502 / 503 / 504)       |
| `CHAOS_LATENCY_RATE`    | `latencyRate` (0..1)                          |
| `CHAOS_LATENCY_MS`      | `latencyMs` (constant ms)                     |
| `CHAOS_ABORT_RATE`      | `abortRate` (0..1)                            |
| `CHAOS_ABORT_STYLE`     | `abortStyle` (`hangup` / `reset`)             |
| `CHAOS_PARTIAL_RATE`    | `partialResponseRate` (0..1, Hono only)       |
| `CHAOS_PARTIAL_AFTER`   | `partialResponseAfterBytes`                   |
| `CHAOS_SLOW_RATE`       | `slowStreaming.rate` (0..1, Hono only)        |
| `CHAOS_SLOW_DELAY`      | `slowStreaming.chunkDelayMs`                  |
| `CHAOS_SLOW_CHUNK`      | `slowStreaming.chunkSize` (rechunk to N bytes) |
| `CHAOS_FLAP_WINDOW`     | `statusFlapping.windowMs` (cycle length)      |
| `CHAOS_FLAP_BAD`        | `statusFlapping.badMs` (sick slice per cycle) |

Examples:

```bash
# Probabilistic 5xx + abort
CHAOS_5XX_RATE=0.1 CHAOS_ABORT_RATE=0.05 pnpm dev:v1

# Windowed 5xx (5 sec sick / 25 sec healthy)
CHAOS_FLAP_WINDOW=30000 CHAOS_FLAP_BAD=5000 pnpm dev:v1

# Partial response (truncate body after 32 bytes for 20% of requests)
CHAOS_PARTIAL_RATE=0.2 CHAOS_PARTIAL_AFTER=32 pnpm dev:v1

# Slow streaming (100 ms between chunks, rechunk to 16-byte pieces)
CHAOS_SLOW_RATE=0.3 CHAOS_SLOW_DELAY=100 CHAOS_SLOW_CHUNK=16 pnpm dev:v1
```

Health checks (`/health`) are always exempt — they'd flap the readiness signal otherwise. `x-chaos-bypass: 1` header bypasses chaos per request (useful for warm-up / fixture probes).

## Sub-agent prompt template

Hand this to an Agent invocation (general-purpose / claude). The agent should NOT read `server.ts` until after it has reported its findings — peeking at `BUG_LEDGER` defeats the dogfood point.

> You have a chaosbringer playground at `playground/` with two variants of the same app (v1 reference, v2 with seeded divergences). Your job:
>
> 1. `cd playground && pnpm loop` — runs parity + chaos crawl + diff against both variants.
> 2. Read `reports/parity.json` and the printed diff output. Identify each distinct divergence.
> 3. For each divergence, write a one-sentence diagnosis (route bug? client-side error? schema drift?) and the evidence that backs it (the specific report field or artifact path).
> 4. **Do not modify code.** Report your findings in a markdown table with columns `id | symptom | evidence | tool that caught it`.
>
> Cap your write-up at 300 words. After you submit, the user will reveal `BUG_LEDGER` and grade.

## Closing the improvement loop

The "improvement" half is a separate Agent invocation:

> You found divergences X, Y, Z (passed in as a list with file:line evidence). Propose minimal code changes to `playground/server.ts` that close them. Run `pnpm loop` after each fix. Stop when the loop exits 0.

Keeping investigation and fix as separate agent runs avoids context pollution and matches the human triage workflow.
