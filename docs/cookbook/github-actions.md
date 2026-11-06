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
    # 10 for the run itself, plus the Playwright install's 25 (see that step).
    timeout-minutes: 35

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

      # `--with-deps` also runs apt-get for Chromium's system packages, and
      # the runner's Ubuntu mirror can be slow rather than down: GitHub's
      # runners have taken 8 to 13.5 minutes for the ~22 MB of fonts apt
      # fetches there. The step bound fails a stalled mirror by name instead
      # of timing out the job, and leaves room for a slow one.
      - if: steps.pw-cache.outputs.cache-hit != 'true'
        timeout-minutes: 25
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
- **A cold cache costs the browser download and apt.** The cache step above
  saves the ~150 MB browser download, worth ~90 seconds per PR. The apt part
  of `--with-deps` depends on the runner's Ubuntu mirror. It usually takes
  seconds, but it has taken over 10 minutes. That is what the 25-minute step
  bound and the job's matching headroom are for.
- **Making apt's part cached too.** This repo's
  [`.github/actions/install-playwright`](https://github.com/mizchi/chaosbringer/blob/main/.github/actions/install-playwright/action.yml)
  keeps apt's downloaded archives in the Actions cache. It checks each one
  against the signed package lists before apt sees it, because apt itself
  trusts a cached archive on name and size alone. To use it, copy it into
  your repo's `.github/actions/`. It runs `pnpm exec playwright` from the repo
  root, so adapt that line for another package manager. Replace the install
  step above with a step that `uses:` it, passing the browser cache's
  `cache-hit` as `browser-cached`, and keep `timeout-minutes` on that step.
  Its header comment explains the design.

## Related

- Feature doc: [`docs/recipes/scenario-load.md`](../recipes/scenario-load.md)
- The SLO API: [`./ci-slo-gating.md`](./ci-slo-gating.md)
- Failure artifact wiring: [`./debugging-failures.md`](./debugging-failures.md)
