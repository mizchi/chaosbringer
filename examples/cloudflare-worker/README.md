# Example — Cloudflare Worker + chaosbringer + server-faults

A minimal end-to-end demo of the chaosbringer + `@mizchi/server-faults` story:

- **Hono** todo app deployed to a Cloudflare Worker (locally via `wrangler dev`).
- **`@mizchi/server-faults`** mounted as Hono middleware on `/api/*` with `metadataHeader: true`.
- **`chaosbringer`** crawl driven by `chaos/run.ts`, using `server: { mode: "remote" }` to ingest the server-emitted `x-chaos-fault-*` response headers.
- A `setup` hook seeds 5 todos using the `x-chaos-bypass` header so the seed phase is unaffected by the chaos middleware.

This is the same shape as the upstream `otel-chaos-lab` repo, condensed to the parts that demonstrate chaosbringer / server-faults orchestration. OTel collector wiring is intentionally omitted — see `otel-chaos-lab` for that.

## Run it

Terminal 1 — start the worker. Pick a chaos profile via env vars:

```bash
# clean run (no chaos middleware)
pnpm dev

# 30% 5xx + 10% latency on /api/* paths
CHAOS_5XX_RATE=0.3 CHAOS_LATENCY_RATE=0.1 CHAOS_LATENCY_MS=1500 pnpm dev
```

Terminal 2 — crawl with chaosbringer:

```bash
pnpm chaos
```

You should see:

```
seeded 5 todos
chaosbringer --url http://localhost:8787 --seed 42 --max-pages 20 …
pages=20 errors=N
server-side fault events: M
  5xx: …
  latency: …
```

## What's connecting the two layers

```
+-- terminal 2: chaosbringer --+        +-- terminal 1: wrangler dev --+
|                              |        |                              |
|  faults.status(500, ...)     |  HTTP  |  honoMiddleware({            |
|  faults.delay(2000, ...)     +------->|    status5xxRate, latency,   |
|  server: { mode: "remote" }  |        |    metadataHeader: true,     |
|  invariants: [...]           |        |    bypassHeader: "...",      |
|                              |        |  })                          |
|  page.on("response") parses  |<-------+  response.headers +=         |
|  x-chaos-fault-* headers     |        |    x-chaos-fault-kind, etc.  |
|                              |        |                              |
|  report.serverFaults[]       |        |                              |
+------------------------------+        +------------------------------+
```

The seed phase (`setup` hook) sends `x-chaos-bypass: 1` so its `POST`s land on
the seed endpoint regardless of `CHAOS_5XX_RATE`. Once the crawler proper
starts, requests *don't* carry the bypass header and the chaos raffle applies.

## Files

```
.
├── README.md          # this file
├── package.json       # workspace package referencing chaosbringer + server-faults via workspace:*
├── tsconfig.json
├── wrangler.toml      # Wrangler dev config, no Cloudflare account needed
├── src/
│   ├── worker.ts      # CF Worker entry — calls into createApp(env)
│   ├── app.ts         # Hono app + chaos middleware wiring
│   └── types.ts       # Env shape
├── chaos/
│   └── run.ts         # chaosbringer driver
└── model/             # model-driven fault coverage for the "add a todo" flow
    ├── todo.qnt       # the contract, as a Quint model
    ├── enumerate.sh   # witness-driven enumeration (dev-time: Quint + JVM)
    ├── targets.txt    # what was asked, what came back unreachable, and
    │                  #   whether a witness was ever possible for it
    ├── traces/        # one ITF witness per reachable state
    ├── plans/         # compiled FaultPlans (committed; replay needs no Quint)
    └── bridge.mjs     # rules / action / uiProbe for this app
```

## Model-driven fault coverage — and the four bugs it found here

The `model/` directory enumerates every way the "Add random todo" flow can
fail and replays each one as a deterministic run
([recipe](../../docs/recipes/model-driven-faults.md)):

```bash
pnpm dev                      # worker on :8787, in one terminal
pnpm model                    # replay all 6 enumerated states, in another
```

`model/todo.qnt` is the *contract* — every rejection handled, every request
bounded, a non-2xx write treated as a failure. Six states are reachable within
4 steps; `stuck` and "a rejection escaped" are proved unreachable, which is the
half a probability sweep can never report.

Both of those unreachable rows are recorded as `unreachable-live`, not as a bare
`unreachable`: `enumerate.sh` ends by re-asking each one against a knob-inverted
copy of the model
([`vacuity.mjs`](../model-faults/patterns/vacuity.mjs), `quint run`, no JVM), so
the file distinguishes "unreachable because the contract forbids it" from
"unreachable because the predicate restates the model's own arithmetic". Here the
checker could have answered either way — flipping `HAS_TIMEOUT` produces a
`stuck` witness in 69 of 400 random traces, and flipping
`HANDLES_EVERY_REJECTION` produces an escaping rejection in 278 — so both
`unreachable` verdicts are results rather than tautologies. Note that
`chaosbringer model run` cannot print the unreachable rows itself
(`States: 6/6 reachable` is the reachable half only); `targets.txt` is where that
claim lives.

This model was written **after** the app, against code that had been here for
months, and the first run reported four findings — all in the write path, none
in the read path (`refresh()` was already correctly guarded):

| Plan | What the app did | Why |
|---|---|---|
| `write-rejected__no-refresh` | `unhandledrejection`, and the list still showed the old todos | the `click` listener was `async` with no `try`/`catch`, so a failed POST escaped *and* the user saw a stale list as if the write had worked |
| `write-errored__no-refresh` | rendered as success | `r.ok` was never checked, so a 500 refreshed the list as if the todo had saved |
| `write-hung__no-refresh` | rendered as success | nothing bounded the POST, so a response that never arrived left the old list on screen |
| (harness) | false "stuck" | the probe's `settleMs` was shorter than the app's own deadline — a bounded request judged as hung. `settleMs` must exceed the app's timeout |

`src/app.ts` now guards the write path the same way it guards the read path
(`try`/`catch`, an `r.ok` check, and `AbortSignal.timeout(5000)`), and all six
plans pass. Regenerating the plans (only needed when the model changes):

```bash
pnpm -F chaosbringer build    # model:compile calls dist/cli.js
pnpm model:enumerate          # traces/ + targets.txt  (needs Quint + a JVM)
pnpm model:compile            # plans/
```

`model:enumerate` also rewrites `targets.txt`'s `contract-forbids-*` rows via
the sibling example's `vacuity.mjs` — one implementation for every model unit in
`examples/`, because a second copy is how this unit ended up unclassified while
the tooling reported "all rows classified". `node
../model-faults/patterns/vacuity.mjs cloudflare-worker/model` does that step
alone, in ~4s and with no JVM.

## Variations to try

- **Tighten the latency window**: drop `CHAOS_LATENCY_MS` to 500 and watch chaosbringer's per-page timing budget reports.
- **Disable network-layer faults**: comment out `faults.status` / `faults.delay` and run with only the server-side chaos. The `report.serverFaults` count should match the worker's `[chaos] 5xx ...` log lines.
- **Disable server-side faults**: leave `pnpm dev` without env vars. `report.serverFaults` will be `undefined` (the field is omitted when no events were observed).
- **Reproducibility**: pass the same `CHAOS_SEED=42` to both the worker (`pnpm dev`) and the chaos driver (`SEED=42 pnpm chaos`). Run twice; verify identical `pages=` / `errors=` / fault-event counts.

## Related docs

- [`docs/recipes/seeding-data.md`](../../docs/recipes/seeding-data.md) — the bypass header + retry patterns this demo uses.
- [`docs/recipes/server-side-correlation.md`](../../docs/recipes/server-side-correlation.md) — full walkthrough of `server: { mode: "remote" }` + `metadataHeader`.
- [`docs/recipes/model-driven-faults.md`](../../docs/recipes/model-driven-faults.md) — what the `model/` directory here is doing, and why.
- [`packages/chaosbringer/README.md`](../../packages/chaosbringer/README.md) — full chaosbringer feature list + CLI reference.
