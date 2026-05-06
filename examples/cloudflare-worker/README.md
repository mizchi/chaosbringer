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
└── chaos/
    └── run.ts         # chaosbringer driver
```

## Variations to try

- **Tighten the latency window**: drop `CHAOS_LATENCY_MS` to 500 and watch chaosbringer's per-page timing budget reports.
- **Disable network-layer faults**: comment out `faults.status` / `faults.delay` and run with only the server-side chaos. The `report.serverFaults` count should match the worker's `[chaos] 5xx ...` log lines.
- **Disable server-side faults**: leave `pnpm dev` without env vars. `report.serverFaults` will be `undefined` (the field is omitted when no events were observed).
- **Reproducibility**: pass the same `CHAOS_SEED=42` to both the worker (`pnpm dev`) and the chaos driver (`SEED=42 pnpm chaos`). Run twice; verify identical `pages=` / `errors=` / fault-event counts.

## Related docs

- [`docs/recipes/seeding-data.md`](../../docs/recipes/seeding-data.md) — the bypass header + retry patterns this demo uses.
- [`docs/recipes/server-side-correlation.md`](../../docs/recipes/server-side-correlation.md) — full walkthrough of `server: { mode: "remote" }` + `metadataHeader`.
- [`packages/chaosbringer/README.md`](../../packages/chaosbringer/README.md) — full chaosbringer feature list + CLI reference.
