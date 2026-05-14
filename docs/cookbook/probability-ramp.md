# Ramp fault probability to find the breaking point

"It works at 5% errors, dies at 30%, what's the threshold?" Sweep `probability`
in a loop and watch the first SLO breach. This is the load-test answer to
"how brittle is our retry / circuit-breaker policy".

```ts
import {
  defineScenario,
  evaluateSlo,
  faults,
  scenarioLoad,
  type SloDefinition,
} from "chaosbringer";

const shop = defineScenario({
  name: "shop",
  steps: [
    { name: "open", run: async ({ page, baseUrl }) => { await page.goto(baseUrl); } },
    { name: "buy",  run: async ({ page })          => { await page.click("[data-test=buy]"); } },
  ],
});

const slo: SloDefinition = {
  steps:     { "shop/buy": { errorRate: 0.05 } },
  scenarios: { shop:       { minThroughputPerSec: 2 } },
};

const probabilities = [0, 0.05, 0.1, 0.2, 0.3, 0.5];
let firstBreak: number | null = null;

for (const p of probabilities) {
  const { report } = await scenarioLoad({
    baseUrl: "http://localhost:3000",
    duration: "30s",
    scenarios: [{ scenario: shop, workers: 5 }],
    faultInjection: p > 0
      ? [faults.status(500, { urlPattern: /\/api\//, probability: p, name: `p=${p}` })]
      : [],
  });

  const verdict = evaluateSlo(report, slo);
  const label = verdict.ok ? "ok" : "FAIL";
  console.log(`p=${p}: ${label}  throughput=${report.scenarios[0].throughputPerSec.toFixed(2)}/s`);
  if (!verdict.ok && firstBreak === null) {
    firstBreak = p;
    for (const v of verdict.violations) console.log(`    ${v.message}`);
  }
}

console.log(firstBreak === null
  ? "Survived every level — try higher probabilities or stricter SLOs"
  : `Breaks at probability=${firstBreak}`);
```

## Output

```
p=0:    ok    throughput=4.31/s
p=0.05: ok    throughput=4.18/s
p=0.1:  ok    throughput=3.92/s
p=0.2:  FAIL  throughput=3.45/s
    [step] shop/buy errorRate=0.082 exceeds 0.05
Breaks at probability=0.2
```

## Variations

- **Bisect** between the last passing `p` and the first failing one for a
  tighter bound.
- **Ramp delay**, not status:
  ```ts
  faults.delay(p * 5000, { urlPattern: /\/api\//, probability: 0.5 })
  ```
  Tests timeout / queue depth instead of retry/error handling.
- **Ramp concurrency**: vary `workers` (5, 10, 20) at a fixed `probability`
  to find the load × failure combo that kills the SUT.

## Gotchas

- 30s per run × 6 levels = 3min. Don't be tempted to shorten to 10s — short
  runs are dominated by ramp-up artefacts and you'll see false-positive
  failures at low probabilities.
- The run is **non-deterministic** by design (think-time + fault dice both
  use `Math.random`). Re-run if a borderline level flips.
- Between runs, **iteration counts won't match exactly** even with identical
  duration — that's fine, you're comparing rates / percentiles, not totals.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- The SLO surface: [`./ci-slo-gating.md`](./ci-slo-gating.md)
