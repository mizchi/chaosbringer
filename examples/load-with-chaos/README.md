# load-with-chaos

Self-contained demo of `scenarioLoad` + `faultInjection` running together.

5 virtual users loop a shop journey (`open → add-to-cart → checkout`) for 8 seconds while 10% of `/api/*` responses are forced to 500. The demo HTTP server runs in-process — no separate `dev` terminal needed.

## Run

```bash
pnpm install
pnpm start
```

You'll see a `LoadReport` printed with:

- per-step latency (p50 / p95 / p99) across all workers,
- per-endpoint sampling for `/` and `/api/*` (the fixture has its own jittered latency so the histogram is non-degenerate),
- a per-500ms timeline sparkline,
- fault-rule stats showing how many `/api/*` requests matched the rule vs. how many were actually injected.

## What this exercises

| Surface | How |
|---|---|
| `defineScenario({ steps, thinkTime })` | 3 steps, scenario-level 200–600ms uniform think time |
| Worker isolation | Each of the 5 virtual users gets its own Playwright `BrowserContext` |
| `rampUp` | Workers stagger their starts over 1s instead of stampeding at t=0 |
| `faultInjection` | 10% of `/api/*` returns 500 — same `faults.*` API as the crawler |
| `invariants` | An "error toast must not be visible" check runs after every step |
| `timeline` (500ms buckets) | Sparkline shows throughput / error rate over the run |
| `faultStats` | Reports how many requests matched + how many were injected |

## Modify

Change the chaos surface in `run.ts`:

```ts
faultInjection: [
  faults.status(500, { urlPattern: "/api/", probability: 1 }),     // 100% failure
  faults.delay(2000,  { urlPattern: "/api/", probability: 0.5 }),  // 50% slow
],
```

Or scale concurrency / duration:

```ts
scenarios: [{ scenario: shop, workers: 20 }],
duration: "2m",
rampUp: "10s",
```

## Why this is useful

Real bugs often need both **load** and **failure** to surface — a flaky retry policy looks fine at 1 RPS or under a 100% outage, but breaks at 5 RPS with 10% errors because the retry storm exhausts a connection pool. Running the two together in one runner makes that interaction visible.
