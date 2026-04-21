# chaosbringer

Playwright-based chaos testing for web apps. Crawls the pages you point it at, performs weighted random actions, injects network faults, evaluates invariants, and reports what broke — with a seed you can replay.

## Features

- **Weighted random actions** targeted by ARIA role and visible text (nav links > buttons > inputs > scroll).
- **Seeded reproducibility** — same seed, same action order. Every report prints a `Repro:` line you can paste into CI logs.
- **Network fault injection** via Playwright's route API: serve a 500, abort, or add latency to any URL pattern.
- **Declarative invariants** evaluated on every page. A violation fails the run regardless of `--strict`.
- **Error detection**: console errors, failed requests, JS exceptions, unhandled rejections, invariant violations.
- **Recovery from 404 / 5xx** — records what actions preceded the failure.
- **Playwright Test integration** for when you'd rather run chaos inside an existing test file.
- **CLI** for running from a shell or CI.

## Install

```bash
pnpm add chaosbringer playwright @playwright/test
npx playwright install chromium
```

`chaosbringer` targets ESM. Programmatic consumers need `"type": "module"` (or `.mts` files) and `playwright` as a peer dependency.

## Quick start — CLI

```bash
# Crawl, then exit 0 / 1 based on navigation outcomes
chaosbringer --url http://localhost:3000

# Dev mode: ignore third-party analytics noise
chaosbringer --url http://localhost:3000 --ignore-analytics

# CI mode: console errors and JS exceptions also fail the run
chaosbringer --url http://localhost:3000 --strict --compact --ignore-analytics

# Reproduce a failing run by pasting its Repro: line
chaosbringer --url http://localhost:3000 --seed 1234567 --max-pages 20
```

## Quick start — programmatic

The shortest path, using the `chaos()` convenience and the `faults` helpers:

```ts
// chaos-test.ts
import { chaos, faults } from "chaosbringer";

async function main() {
  const { report, passed } = await chaos({
    baseUrl: "http://localhost:3000",
    seed: 42,
    maxPages: 20,
    strict: true,
    faultInjection: [
      faults.status(500, { urlPattern: /\/api\// }),
      faults.delay(2000, { urlPattern: /\/slow\// }),
    ],
    invariants: [
      {
        name: "cart-count-non-negative",
        when: "afterActions",
        async check({ page }) {
          const n = Number(await page.locator("[data-cart-count]").textContent());
          return n >= 0 || `cart count was ${n}`;
        },
      },
    ],
  });

  console.log(report.reproCommand);
  process.exit(passed ? 0 : 1);
}
main();
```

The examples wrap in `async function main()` because a plain `.ts` file under an unconfigured project can't use top-level `await`.

### Lower-level API

If you need more control than `chaos()` exposes:

```ts
import { ChaosCrawler, getExitCode } from "chaosbringer";

async function main() {
  const crawler = new ChaosCrawler({
    baseUrl: "http://localhost:3000",
    seed: 42,
  });
  const report = await crawler.start();
  process.exit(getExitCode(report, /* strict */ true));
}
main();
```

## Reproducible runs

Every report includes:
- `report.seed` — the seed actually used (random if you didn't pass one).
- `report.reproCommand` — a shell-safe invocation that rebuilds the same run.

Both are printed in the compact header (`[PASS] … (seed=42)`) and the full report (`Seed: 42` / `Repro: chaosbringer --url … --seed 42`).

To rerun an exact failure locally, copy the `Repro:` line from CI.

## Fault injection

Fault rules let you force specific network requests to fail, delay, or return a canned response. Use the `faults` helpers to build rules without the discriminated-union noise:

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  faultInjection: [
    // Always 500 on /api/*
    faults.status(500, { urlPattern: /\/api\// }),

    // 30% of the time, return a 429 with a Retry-After body
    faults.status(429, {
      urlPattern: /\/api\/orders$/,
      methods: ["POST"],
      probability: 0.3,
      body: "Retry-After: 5",
      contentType: "text/plain",
    }),

    // Abort tracking pixels
    faults.abort({ urlPattern: /tracking/ }),

    // Add 2s of latency to one endpoint
    faults.delay(2000, { urlPattern: /\/api\/search/ }),
  ],
});
```

`probability` is evaluated against the seeded RNG — same seed, same pattern of injections.

Per-rule `matched` / `injected` counters end up in `report.faultInjections`.

## Invariants

Invariants are assertions that must hold on every page. They run either `afterLoad` (right after navigation) or `afterActions` (default — after chaos clicks/inputs). Returning `false`, throwing, or returning a string all count as a failure; returning `true` or `void` means the invariant held.

```ts
import { chaos, type Invariant } from "chaosbringer";

const invariants: Invariant[] = [
  {
    name: "has-h1",
    when: "afterLoad",
    async check({ page }) {
      return (await page.locator("h1").count()) > 0 || "no <h1>";
    },
  },
  {
    name: "no-loading-spinner-after-actions",
    urlPattern: /\/spa\//,
    async check({ page }) {
      const t = (await page.locator("#app").textContent()) ?? "";
      return !/loading/i.test(t) || `app still shows loading: "${t}"`;
    },
  },
];

const { passed } = await chaos({ baseUrl: "http://localhost:3000", invariants });
```

Violations always fail the run (exit 1), whether or not `strict` is set — a declared invariant is a stronger signal than console noise.

## Exit codes

| Condition | Exit |
| --- | --- |
| No navigation errors, no invariant violations | **0** |
| At least one page with `status: "error"` or `"timeout"` | **1** |
| At least one invariant violation (any mode) | **1** |
| `--strict` and any console error / JS exception | **1** |

`chaos()` returns `{ passed, exitCode }`; the CLI applies the same rule via `getExitCode`.

## Playwright Test integration

Use the pre-configured `chaosTest`:

```ts
import { chaosTest, chaosExpect } from "chaosbringer";

chaosTest("chaos-test homepage", async ({ page, chaos }) => {
  await page.goto("http://localhost:3000");
  const result = await chaos.testPage(page, page.url());
  chaosExpect.toHaveNoExceptions(result);
  chaosExpect.toLoadWithin(result, 3000);
});
```

Or extend your existing test:

```ts
import { test as base } from "@playwright/test";
import { withChaos, type ChaosFixtures } from "chaosbringer";

const test = base.extend<ChaosFixtures>(
  withChaos({ maxActionsPerPage: 10, ignoreErrorPatterns: ["analytics"] }),
);

test("my feature", async ({ page, chaos }) => {
  await page.goto("/dashboard");
  const result = await chaos.testPage(page, page.url());
  chaos.expectNoErrors(result);
});
```

Or crawl from within a fixture-based test:

```ts
chaosTest("crawl entire site", async ({ chaos }) => {
  const report = await chaos.crawl("http://localhost:3000");
  chaos.expectNoErrors(report);
});
```

## CLI reference

| Option | Description | Default |
| --- | --- | --- |
| `--url <url>` | Base URL (required) | — |
| `--max-pages <n>` | Max pages visited | 50 |
| `--max-actions <n>` | Max random actions per page | 5 |
| `--timeout <ms>` | Page load timeout | 30000 |
| `--no-headless` | Show the browser window | headless |
| `--screenshots` | Take screenshots | false |
| `--screenshot-dir <path>` | Screenshot directory | `./screenshots` |
| `--output <path>` | Report path | `chaos-report.json` |
| `--exclude <pattern>` | Skip URLs matching regex (repeatable) | — |
| `--ignore-error <pattern>` | Suppress errors matching regex (repeatable) | — |
| `--ignore-analytics` | Suppress common analytics noise† | false |
| `--spa <pattern>` | Mark matching URLs as SPA (errors bucketed separately, repeatable) | — |
| `--log-file <path>` | JSON execution log | — |
| `--log-level <level>` | `debug` / `info` / `warn` / `error` | info |
| `--log-console` | Also log to console | false |
| `--seed <n>` | Seed for deterministic action selection | random |
| `--compact` | Compact output | false |
| `--strict` | Fail on console errors + JS exceptions | false |
| `--quiet` | Minimal output | false |
| `--help` | Show help | — |

† `--ignore-analytics` suppresses matches for `googletagmanager`, `google-analytics`, `analytics.google`, `hotjar`, `clarity.ms`, `segment.io`, `amplitude`, `cloudflareinsights`, `facebook.net`, and generic `net::ERR_FAILED` from blocked resources. See `COMMON_IGNORE_PATTERNS` in `src/crawler.ts`.

Fault injection and invariants are programmatic-only — they can't be expressed in a shell command and are intentionally absent from the CLI.

## Action weighting

| Element type | Default weight |
| --- | --- |
| Navigation links (in `<nav>` / `<header>`) | 4.5 (3 × 1.5) |
| Regular links | 3.0 |
| Buttons | 2.0 |
| ARIA interactive roles | 2.0 |
| Input fields | 1.0 |
| Scroll | 0.5 |

Elements with visible text get a 1.5× multiplier.

```ts
new ChaosCrawler({
  baseUrl: "http://localhost:3000",
  actionWeights: { navigationLinks: 5, buttons: 3, inputs: 0.5, scroll: 0.1 },
});
```

## Error types

- `console` — `console.error(...)` calls
- `network` — failed requests
- `exception` — uncaught JS errors
- `unhandled-rejection` — unhandled promise rejections
- `invariant-violation` — a declared invariant failed
- `crash` — the page crashed

`PageResult.status` reports the navigation outcome (`success` / `error` / `timeout` / `recovered`), not whether the page was healthy. A page can be `success` with exceptions on it — check `PageResult.hasErrors` or `report.summary.pagesWithErrors` for the full picture.

## Report shape (abridged)

```json
{
  "baseUrl": "http://localhost:3000",
  "seed": 42,
  "reproCommand": "chaosbringer --url http://localhost:3000 --seed 42 --max-pages 20",
  "duration": 12345,
  "pagesVisited": 20,
  "totalErrors": 2,
  "blockedExternalNavigations": 5,
  "recoveryCount": 1,
  "pages": [
    {
      "url": "http://localhost:3000/",
      "status": "success",
      "statusCode": 200,
      "loadTime": 500,
      "errors": [],
      "hasErrors": false,
      "metrics": { "ttfb": 50, "fcp": 120 }
    }
  ],
  "summary": {
    "successPages": 20,
    "pagesWithErrors": 1,
    "consoleErrors": 1,
    "jsExceptions": 1,
    "unhandledRejections": 0,
    "invariantViolations": 0
  },
  "faultInjections": [{ "rule": "api-500", "matched": 4, "injected": 4 }]
}
```

## License

MIT
