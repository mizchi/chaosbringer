# Read cause-and-effect from the fault timeline

The whole point of running chaos *during* load is to see what fails because
of the fault and what would have failed anyway. `LoadReport.timeline` puts
iterations, errors, and per-rule fault firings on the **same time axis** so
you can read the correlation by eye.

```ts
import {
  defineScenario,
  faults,
  formatLoadReport,
  scenarioLoad,
} from "chaosbringer";

const browse = defineScenario({
  name: "browse",
  thinkTime: { minMs: 300, maxMs: 800 },
  steps: [
    { name: "home",     run: async ({ page, baseUrl }) => { await page.goto(baseUrl); } },
    { name: "catalog",  run: async ({ page })          => { await page.click("[data-test=catalog]"); } },
  ],
});

const { report } = await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "60s",
  timelineBucketMs: 1000,                       // 1s buckets — match wall-clock intuition
  scenarios: [{ scenario: browse, workers: 8 }],
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.1, name: "api-500" }),
    faults.delay(2000, { urlPattern: /\/api\//, probability: 0.05, name: "api-slow" }),
  ],
});

console.log(formatLoadReport(report));
```

## Reading the output

```
Timeline (bucket=1.0s):
  iterations      ▁▃▆▇█▇▆▃▁▁▁▃▆▇█
  errors          ▁▁▁▁▁█▇▆▃▁▁▁▁▁▁
  fault:api-500   ▁▁▁▁▁█▇▆▃▁▁▁▁▁▁    ← lines up with `errors` → this rule caused it
  fault:api-slow  ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁    ← fired but errors didn't follow → app handled it
  peak: 8/bucket
```

If `errors` jumps with `fault:api-500` but **doesn't** jump with `fault:api-slow`,
your retry/timeout policy is absorbing slow responses but not 5xx — a real
signal, not a vibe.

## Programmatic correlation

```ts
// Find the worst bucket and what rule was firing then.
const worst = report.timeline.reduce(
  (a, b) => (b.iterationFailures > a.iterationFailures ? b : a),
);
console.log(`Worst bucket: t=${worst.tMs}ms`);
console.log(`  iterations=${worst.iterations}, failures=${worst.iterationFailures}`);
console.log(`  fault firings:`, worst.faults);
```

## Gotchas

- **Only network faults (`faultInjection`) appear in the `fault:*` rows.**
  `runtimeFaults` (in-page JS monkey patches) fire client-side and their
  stats don't carry timestamps in v1 — they show up in `report.runtimeFaults`
  as totals instead.
- Bucket width is a tradeoff: 1s reads naturally, 100ms shows micro-bursts
  but the sparkline gets noisy. Try `timelineBucketMs: 500` for runs ≥ 30s.
- Every fault rule appears in every bucket's `faults` map (zero-filled), so
  `bucket.faults["api-500"]` is always a number, not `undefined`.

## Related

- Feature docs: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- Add CI gating on top: [`./ci-slo-gating.md`](./ci-slo-gating.md)
- Search for the breaking probability: [`./probability-ramp.md`](./probability-ramp.md)
