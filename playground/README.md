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
```

Outputs land in:

- `reports/parity.json` — full parity report (status / redirect / failure mismatches)
- `reports/v1.json` / `reports/v2.json` — chaosbringer crawl reports
- `artifacts/v1/` / `artifacts/v2/` — per-page failure bundles
- `artifacts/{v1,v2}/clusters/` — one representative bundle per error cluster (via `--cluster-artifacts`)

## Exercise individual fault kinds

Every fault kind shipped on this PR is reachable via env vars passed to either variant. Examples:

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
