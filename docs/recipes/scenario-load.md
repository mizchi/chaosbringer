# Scenario-load — realistic user workers, optionally under chaos

> Looking for a paste-and-edit snippet for a specific task? Try the cookbook
> first: [CI gating](../cookbook/ci-slo-gating.md), [fault timeline](../cookbook/chaos-under-load.md),
> [per-worker auth](../cookbook/per-worker-auth.md), [probability ramp](../cookbook/probability-ramp.md),
> [think-time shaping](../cookbook/think-time-shaping.md). This doc is the
> longer "what is this feature and why".

`scenarioLoad()` runs N "virtual users" in parallel, each looping a scripted user journey (login → browse → checkout → …) with realistic think time, and produces a `LoadReport` with per-step latency percentiles and per-endpoint timing. Combine with `faultInjection` / `runtimeFaults` to ask the chaos question under realistic concurrency: *does the app still work when 10 users hit checkout while half the API responses 500?*

## When to reach for it

| Goal | Tool |
|---|---|
| "Explore unknown UI, find error states." | `chaos()` crawler |
| "Different bug classes in parallel, single wall-clock window." | `parallelChaos()` |
| "**Known** user journey under realistic concurrency + chaos." | **`scenarioLoad()`** |
| "Maximise RPS, p99 SLO enforcement, 100+ workers." | k6 / Artillery (out of scope here) |

This runner is biased toward **bugs under load**, not RPS maxing. 10 workers × 1–5 minutes is the design point.

## Anatomy

```ts
import { scenarioLoad, defineScenario, formatLoadReport, faults } from "chaosbringer";

const checkout = defineScenario({
  name: "checkout",
  thinkTime: { minMs: 800, maxMs: 2500 },
  steps: [
    {
      name: "open",
      run: async ({ page, baseUrl }) => {
        await page.goto(`${baseUrl}/`);
        await page.waitForSelector("nav");
      },
    },
    {
      name: "add-to-cart",
      run: async ({ page }) => {
        await page.click("[data-test=add-to-cart]");
      },
    },
    {
      name: "checkout",
      thinkTime: { distribution: "none" }, // hot loop on the final step
      run: async ({ page }) => {
        await page.click("[data-test=checkout]");
        await page.waitForURL(/\/thanks/);
      },
    },
  ],
});

const { report } = await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "2m",
  rampUp: "10s",                            // stagger worker starts
  scenarios: [
    { scenario: checkout, workers: 10 },
  ],
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.1 }),
  ],
  invariants: [
    {
      name: "no-error-toast",
      check: async ({ page }) =>
        (await page.locator(".error-toast").count()) === 0 || "error toast visible",
    },
  ],
});

console.log(formatLoadReport(report));
process.exit(report.totals.iterationFailures > 0 ? 1 : 0);
```

## Scenario design

A `Scenario` is a list of `ScenarioStep`s the worker runs in order, repeating from the top until the run's `duration` expires or `maxIterationsPerWorker` is hit.

Each step:
- has a stable `name` (used as a key in the latency rollup),
- gets a `ScenarioContext` with `page`, `workerIndex`, `iteration`, `baseUrl`,
- runs to completion or throws — a thrown error fails the step *and* aborts the iteration (set `optional: true` to keep going).

**Think time** between steps is configurable at three levels (step > scenario > runner default). Pass `{ distribution: "none" }` for batch traffic, `{ distribution: "gaussian" }` for clustered around the midpoint, or the default `uniform` between `minMs` and `maxMs` (defaults: 1000–3000ms).

`beforeIteration` / `afterIteration` hooks fire around each iteration — handy for resetting state with `await page.context().clearCookies()` between loops.

## Workers and isolation

- 1 worker = 1 Playwright `BrowserContext` (clean cookies / storage / cache).
- All workers share **one** Chromium process — much cheaper than per-worker browsers.
- Workers ramp up linearly over `rampUp` so you don't get a thundering-herd spike masking steady-state behaviour.
- No shared state between workers. Each has its own RNG, sampler, and invariant state map.

For per-worker logged-in identities, use `storageState`:

```ts
scenarios: [
  {
    scenario: shoppingScenario,
    workers: 5,
    storageState: (workerIndex) => `./fixtures/storage/user-${workerIndex}.json`,
  },
],
```

## What you get

`LoadReport` exposes:

| Field | What |
|---|---|
| `totals.iterations` / `iterationFailures` / `stepFailures` | Run-wide counters. |
| `totals.networkRequests` / `networkErrors` | Counts a request as errored if `status == 0` or `status >= 500`. |
| `scenarios[].throughputPerSec` | iterations / wall-clock seconds. |
| `scenarios[].steps[].latency.{p50Ms,p95Ms,p99Ms}` | Per-step percentiles across every worker × iteration. |
| `endpoints[].latency` | Same shape, keyed by URL pattern (numeric ids → `:id`, UUIDs → `:uuid`). |
| `workers[]` | Per-worker iteration counts (debugging). |
| `timeline[]` | Per-bucket counts (`iterations`, `iterationFailures`, `networkRequests`, `networkErrors`, **`faults: Record<ruleName, count>`**). Default bucket: 1000ms. Configure with `timelineBucketMs`. `formatLoadReport` renders this as a sparkline with one row per fired fault rule. |
| `errors[]` | Capped flat error list (200 max) — first errors win. |

## Recipe: chaos + scenario load

```ts
import { scenarioLoad, defineScenario, faults } from "chaosbringer";

await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "5m",
  scenarios: [
    { scenario: browsingScenario, workers: 7 },
    { scenario: checkoutScenario, workers: 3 },
  ],
  // Chaos runs THROUGHOUT the load run — every worker sees these.
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\/checkout/, probability: 0.05 }),
    faults.delay(2000, { urlPattern: /\/api\//, probability: 0.02 }),
  ],
});
```

## Recipe: ramp + storage state for per-user identity

```ts
const sessions = [
  "./fixtures/storage/alice.json",
  "./fixtures/storage/bob.json",
  "./fixtures/storage/carol.json",
];

await scenarioLoad({
  baseUrl: "https://staging.example.com",
  duration: "10m",
  rampUp: "30s",
  scenarios: [
    {
      scenario: dashboardScenario,
      workers: sessions.length,
      storageState: (i) => sessions[i],
    },
  ],
});
```

## Recipe: correlating chaos with throughput dips

`report.timeline` is bucketed per-second by default. Combine with chaos
that fires at a known wall-clock to see the impact directly:

```ts
const { report } = await scenarioLoad({
  baseUrl: "...",
  duration: "60s",
  timelineBucketMs: 1000,
  scenarios: [{ scenario, workers: 5 }],
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\/checkout/, probability: 0.5 }),
  ],
});

// Find the worst bucket.
const worst = report.timeline.reduce(
  (a, b) => (b.iterationFailures > a.iterationFailures ? b : a),
);
console.log(`Worst bucket: t=${worst.tMs}ms, fail=${worst.iterationFailures}`);
```

The ASCII formatter renders this as a sparkline so you can eyeball the run. Each fault rule that actually fired gets its own row, named via the rule's `name`:

```
Timeline (bucket=500ms):
  iterations      ▁▁▂▄▂▄▄▄▅▂▄▅▁▇▂▂█
  errors          ▁▁▁▁▁▁▁█▅▅█▁▅▅▁▁▁
  fault:api-500   ▁▁▁▁▁▁▁█▃▃█▁▃▃▁▁▁
  peak: 5/bucket
```

The fault row lines up with the `errors` row by construction — that's the cause-and-effect you came here to see.

## Recipe: browser cost under load (`perf`)

Step latency says how long a step took; it does not say whether the browser
was the bottleneck. With `perf` on, a few sampled workers measure every step
as a [lightbringer](../../packages/lightbringer) span, the same measurement
the crawler's `--perf` makes (see [perf.md](./perf.md)):

```ts
const { report } = await scenarioLoad({
  baseUrl: "http://localhost:3000",
  scenarios: [{ scenario: shop, workers: 10 }],
  duration: "2m",
  rampUp: "60s",
  perf: true, // ≡ { level: "light", sampleWorkers: 1 }
});
```

| Option (`perf: { … }`) | Default | What |
|---|---|---|
| `level: "light"` | `"light"` | The only level. `"trace"` throws: a Chrome trace per worker streams to disk and loads the renderer every worker shares, so it would distort the concurrency it is there to observe. |
| `sampleWorkers` | `1` | How many workers **of each scenario spec** measure (its first N, capped at `workers`). The rest run unmeasured. |

What it adds to the `LoadReport`:

| Field | What |
|---|---|
| `config.perf` | `{ level, sampledWorkers }` — total measured workers. |
| `scenarios[].steps[].perf` | `{ n, durationMs, blockingMs, interactionMs? }` over the sampled workers' executions of the step, each `{ p50, p95 }` in ms. `blockingMs` is total long-task time in the span; `interactionMs` is the span's worst interaction (input → next paint) over the `n` spans that had one, absent when none did. Absent when no sampled worker ran the step. |
| `timeline[].perf` | `{ startedWorkers, spans, blockingMsP50, blockingMsP95 }` per bucket: spans that ended in the bucket, and how many workers the ramp-up had started by its end. |

`formatLoadReport` adds a `browser …` line under each measured step and two
timeline rows, so blocking can be read against concurrency:

```
  click                     n=   27  err=   0  p50=182ms  p95=192ms  p99=223ms
                            browser n=12  dur p50=184ms p95=196ms  blocking p50=121ms p95=122ms  inp p50=120ms p95=128ms (n=12)
  …
  workers         ▂▄▆███
  blocking p95    ▁▂▃▅▇█
```

Gate on it with `StepSloThresholds.perf` (below). How it works and what it costs:

- Each sampled step is one span: it opens before the step's wall-clock start
  and closes after its end, with no settle, so the step's `latency` does not
  include the measurement. The iteration does: opening and closing the span
  (a few CDP calls and in-page reads per step) happens inside it, so the
  sampled worker's iteration durations are longer and its throughput lower
  (on the e2e fixture, about 20 %). It adds a little less load than an
  unmeasured worker, and turning `perf` on can move a scenario-level
  `minThroughputPerSec` or anything read from iteration durations — set
  those against a run with the same `perf` setting.
- A failed step is measured too — its cost is part of what the page saw.
- The in-page collector goes onto the sampled worker's context ahead of the
  `runtimeFaults` script, so a `clock-skew` fault does not skew the spans.
  Unsampled workers get no collector at all.
- `interactionMs` is read at the end of the run (lightbringer's final drain),
  so an interaction whose paint landed after its step ended is still counted.
  Measurement never fails the run: a worker whose session cannot open runs
  unmeasured, and a final read that hangs falls back to what was gathered.

## Recipe: SLO gating in CI

`assertSlo()` throws an error listing every breached threshold so the
load run fails CI loudly:

```ts
import { assertSlo, scenarioLoad, type SloDefinition } from "chaosbringer";

const { report } = await scenarioLoad({ /* ... */ });

const slo: SloDefinition = {
  // Step key format: "scenarioName/stepName"
  steps: {
    "shop/checkout": { p95Ms: 800, errorRate: 0.05 },
    // Browser-side, from `perf` (ms): durationMs / blockingMs / interactionMs × P50 / P95.
    "shop/add-to-cart": { perf: { blockingMsP95: 100, interactionMsP95: 200 } },
  },
  scenarios: {
    shop: { minThroughputPerSec: 3 },
  },
  endpoints: {
    "/api/checkout": { p99Ms: 1500, errorRate: 0.05 },
  },
  totals: {
    maxNetworkErrors: 50,
  },
};

assertSlo(report, slo); // throws on any breach; thrown error.violations carries the structured list
```

Comparisons are inclusive: `p95Ms: 800` passes if actual ≤ 800.
`minThroughputPerSec` is the only "must be ≥" threshold (everything
else is a max). Missing targets (e.g. a step the report didn't see)
are themselves violations — the point of an SLO is to express
expectations, so a silently-skipped check defeats the purpose.

A `perf` threshold on a step that has no `perf` (perf off, or no sampled
worker ran the step) is a violation with `actual: null`, and so is an
`interactionMs*` threshold on a step none of whose spans had an interaction:
a browser SLO nothing measured has not passed.

If you want non-throwing handling, use `evaluateSlo(report, slo)` which
returns `{ ok, violations[] }`.

## Limits / non-goals

- **No SLO enforcement.** Inspect `report.scenarios[].steps[].latency` yourself if you want pass/fail on latency.
- **No `lifecycleFaults`.** They are tied to crawler page-lifecycle stages which don't map to load worker iteration boundaries. Use `faultInjection` (network) and `runtimeFaults` (in-page JS) instead.
- **No graceful in-flight cancellation.** Workers check the deadline at step boundaries, so a long step at the end of the run can overrun by up to its own duration.
