# Fail CI on latency / error regression

You want the build to go red when p95 of `/api/checkout` blows past 800ms or
when iteration error rate climbs over 5% — without scrolling through a 200-line
log to spot it. `assertSlo()` is a one-call gate against a `LoadReport`.

```ts
import {
  assertSlo,
  defineScenario,
  formatLoadReport,
  scenarioLoad,
  type SloDefinition,
} from "chaosbringer";

const checkout = defineScenario({
  name: "checkout",
  steps: [
    { name: "open",     run: async ({ page, baseUrl }) => { await page.goto(baseUrl); } },
    { name: "buy",      run: async ({ page })          => { await page.click("[data-test=buy]"); } },
  ],
});

const { report } = await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "2m",
  scenarios: [{ scenario: checkout, workers: 10 }],
});

const slo: SloDefinition = {
  // key format: "scenarioName/stepName"
  steps:     { "checkout/buy":   { p95Ms: 800, errorRate: 0.05 } },
  scenarios: { "checkout":       { minThroughputPerSec: 3 } },
  endpoints: { "/api/checkout":  { p99Ms: 1500, errorRate: 0.05 } },
  totals:    { maxNetworkErrors: 50 },
};

console.log(formatLoadReport(report));
assertSlo(report, slo); // throws on any breach, exit code != 0
```

## What you get on failure

`assertSlo` throws an `Error` whose message lists every breached threshold and
whose `.violations` field is the structured list — so you can pretty-print or
forward to a reporter:

```
Error: SLO failed: 2 violation(s)
  - [step] checkout/buy p95Ms=1240 exceeds 800
  - [scenario] checkout minThroughputPerSec=1.8 below 3
```

## Gotchas

- **Missing targets are themselves violations.** If `report.scenarios` doesn't
  contain `"checkout"` (typo, or that scenario produced zero iterations) the
  SLO will fail with `[scenario] "checkout" not found in report`. This is on
  purpose — silently passing on a missing target defeats the contract.
- **Endpoint keys are normalised**: `/api/users/42` → `/api/users/:id` (UUIDs
  → `:uuid`, long hex → `:hex`). Use the normalised form in your SLO map.
- If you need non-throwing handling (e.g. to keep running and surface multiple
  reports), use `evaluateSlo(report, slo) → { ok, violations }` instead.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- Wire this into CI: [`./github-actions.md`](./github-actions.md)
- Runnable demo with SLO at the end: [`examples/load-with-chaos/`](../../examples/load-with-chaos/)
