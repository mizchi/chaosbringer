# Wire chaos into GitHub Actions

Minimal workflow that boots the app, runs `scenarioLoad` with chaos, fails
the build on SLO breach, and uploads the JSON report + failure artifacts
for post-mortem.

```yaml
# .github/workflows/chaos.yml
name: chaos
on: [pull_request]

jobs:
  load-and-chaos:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with: { version: 10 }

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # Cache the Playwright browser binaries (~150 MB).
      - id: pw-cache
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: pw-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}

      - if: steps.pw-cache.outputs.cache-hit != 'true'
        run: pnpm exec playwright install --with-deps chromium

      # Boot the app. Adapt to your stack — Docker compose, `pnpm dev`, etc.
      - run: pnpm dev &
      - run: npx wait-on http://localhost:3000 --timeout 60000

      # Run the chaos suite. Exits non-zero on SLO breach.
      - run: pnpm chaos:ci
        env:
          BASE_URL: http://localhost:3000

      # Always upload artifacts so we can post-mortem when red.
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: chaos-report
          path: |
            out/report.json
            out/failures/
          retention-days: 14
```

## The driver script (`scripts/chaos-ci.ts`)

```ts
import { writeFileSync } from "node:fs";
import {
  assertSlo,
  defineScenario,
  faults,
  formatLoadReport,
  scenarioLoad,
  type SloDefinition,
} from "chaosbringer";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";

const checkout = defineScenario({
  name: "checkout",
  steps: [
    { name: "open", run: async ({ page }) => { await page.goto(baseUrl); } },
    { name: "buy",  run: async ({ page }) => { await page.click("[data-test=buy]"); } },
  ],
});

const { report } = await scenarioLoad({
  baseUrl,
  duration: "60s",
  scenarios: [{ scenario: checkout, workers: 5 }],
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.1, name: "api-500" }),
  ],
});

// Persist for the CI artifact upload, no matter what happens next.
writeFileSync("./out/report.json", JSON.stringify(report, null, 2));

console.log(formatLoadReport(report));

const slo: SloDefinition = {
  steps:     { "checkout/buy":  { p95Ms: 1500, errorRate: 0.15 } },
  scenarios: { checkout:        { minThroughputPerSec: 2 } },
  totals:    { maxNetworkErrors: 200 },
};
assertSlo(report, slo);   // throws → exit 1 → CI red
```

`package.json`:

```json
{
  "scripts": {
    "chaos:ci": "tsx scripts/chaos-ci.ts"
  }
}
```

## What this gives you on a red build

1. The job log shows the formatted `LoadReport` + the SLO violation list.
2. `out/report.json` is downloadable for diffing against `main`.
3. `out/failures/` contains traces if you also configured `failureArtifacts`
   on a `chaos()` crawler run.

## Variations

- **PR comment with the result**: pipe the formatted report into
  `gh pr comment`. Be selective — full report is too long; post only the
  violation list.
- **Comparing against main**: download the previous run's `report.json` and
  diff `report.scenarios[0].steps[i].latency.p95Ms`. Fail on regressions
  above a delta (`p95 grew by > 20%`).
- **Run multiple chaos profiles in parallel**: jobs strategy matrix with
  `probability: [0.05, 0.1, 0.2]` — three jobs, three reports, surface
  separately.

## Gotchas

- **Don't run chaos against production.** It's tautological but worth
  saying — `faults.status(500)` is a route interceptor; only your test
  traffic sees the 500. But if your CI shares network with prod (proxy,
  service mesh), double-check.
- **`pnpm dev &` is fragile.** Real CI usually wants a `docker compose up`
  or a built bundle running on a known port. The pattern above is the
  smallest reproducer, not what you should ship.
- **Browser binaries dominate cold-cache install time.** The cache step
  above is worth ~90 seconds per PR.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- The SLO API: [`./ci-slo-gating.md`](./ci-slo-gating.md)
- Failure artifact wiring: [`./debugging-failures.md`](./debugging-failures.md)
