# Scenario-load — realistic user workers, optionally under chaos

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

## Limits / non-goals

- **No SLO enforcement.** Inspect `report.scenarios[].steps[].latency` yourself if you want pass/fail on latency.
- **No time-windowed RPS.** Only run-totals — for time-series, capture per-iteration timestamps and aggregate yourself.
- **No `lifecycleFaults`.** They are tied to crawler page-lifecycle stages which don't map to load worker iteration boundaries. Use `faultInjection` (network) and `runtimeFaults` (in-page JS) instead.
- **No graceful in-flight cancellation.** Workers check the deadline at step boundaries, so a long step at the end of the run can overrun by up to its own duration.
