# chaosbringer

Playwright-based chaos testing for web apps. Crawls the pages you point it at, performs weighted random actions, injects network faults, evaluates invariants, and reports what broke — with a seed you can replay.

## Features

- **Weighted random actions** targeted by ARIA role and visible text (nav links > buttons > inputs > scroll).
- **Thorough link extraction** — `<a>`, `<area>`, `<iframe>`, `<link rel="canonical"/"alternate">`, and `<meta http-equiv="refresh">` feed the queue, so dead-link coverage isn't limited to clickable anchors.
- **Seeded reproducibility** — same seed, same action order. Every report prints a `Repro:` line you can paste into CI logs.
- **Network fault injection** via Playwright's route API: serve a 500, abort, or add latency to any URL pattern.
- **Declarative invariants** evaluated on every page. A violation fails the run regardless of `--strict`.
- **Accessibility checks** via an `invariants.axe()` preset — axe-core is an optional peer dep.
- **Performance budgets** per TTFB / FCP / LCP / TBT — budget breaches fail the run.
- **Visual regression** via pixelmatch — compare per-page screenshots against baselines, fail on diff.
- **Error detection**: console errors, failed requests, JS exceptions, unhandled rejections, invariant violations.
- **Recovery from 404 / 5xx** — records what actions preceded the failure.
- **HAR record / replay** + **trace record / replay / minimize** for fully deterministic runs and delta-debugged repros.
- **Baseline diff** — surface new clusters / newly failing pages vs a previous run.
- **Flake detection** — rerun the same crawl N times and flag clusters / pages whose outcome varies.
- **Action heatmap** — pure aggregation of `report.actions[]` exposing the most-hit and most-failed targets.
- **Authenticated crawls** via Playwright storageState, **device emulation** (iPhone, Pixel, …), **network throttling** (slow-3g, fast-3g, offline).
- **Sitemap seeding** — prepend every URL in a sitemap.xml (or sitemap index) to the queue.
- **Parallel sharding** — split a crawl across N processes with `--shard i/N`, then merge via the `shard` subcommand.
- **GitHub Actions annotations** — emit `::error` / `::warning` lines so failures show up on the run summary.
- **Playwright Test integration** for when you'd rather run chaos inside an existing test file.
- **CLI** for running from a shell or CI, with `minimize` / `flake` / `shard` subcommands.

## Install

```bash
pnpm add chaosbringer playwright @playwright/test
npx playwright install chromium
```

`chaosbringer` targets ESM. Programmatic consumers need `"type": "module"` (or `.mts` files) and `playwright` as a peer dependency.

### Installing from a git ref

`chaosbringer` is currently distributed via GitHub (no npm package yet). Both forms work:

```bash
# pin a commit SHA
pnpm add chaosbringer@github:mizchi/chaosbringer#<sha>

# track main
pnpm add chaosbringer@github:mizchi/chaosbringer
```

The repository ships a built `dist/` directory and a `prepare` script, so `pnpm install` / `npm install` works out of the box without a manual build step. If you're hacking on `chaosbringer` itself, run `pnpm build` to refresh `dist/` before committing.

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

## Device emulation & network throttling

Emulate mobile devices or throttle the network to catch bugs that only surface on slow connections or small viewports.

```bash
chaosbringer --url http://localhost:3000 --device "iPhone 14" --network slow-3g
```

- `--device <name>` — any Playwright device descriptor (`iPhone 14`, `Pixel 7`, `iPad Pro 11`, `Desktop Chrome`, …). Sets viewport, user-agent, device pixel ratio, mobile / touch flags via `newContext({ ...devices[name] })`. Unknown names fail validation up-front.
- `--network <profile>` — `slow-3g`, `fast-3g`, or `offline`. Attaches a CDP session per page and calls `Network.emulateNetworkConditions` with the same values Chrome DevTools' presets use.

Combining the two lets you measure perf budgets under realistic conditions: `chaosbringer --url … --device "Pixel 7" --network slow-3g --budget lcp=4000`.

## Sitemap seeding

Prepend every URL in a sitemap.xml (or sitemap index) to the crawl queue — essential for sites whose nav is JS-rendered and so gets missed by DOM link extraction.

```bash
chaosbringer --url https://docs.example.com --seed-from-sitemap https://docs.example.com/sitemap.xml
```

Accepts a URL or a local path. Sitemap indexes are followed breadth-first; referenced URLs outside the baseUrl origin are dropped to avoid wasting visit budget. A runaway index (suspected cycle) fails fast.

```ts
import { fetchSitemapUrls } from "chaosbringer";
const urls = await fetchSitemapUrls("https://docs.example.com/sitemap.xml");
```

## Authenticated crawls (storage state)

To crawl pages behind a login, point chaosbringer at a Playwright `storageState` file — the JSON containing cookies + localStorage that a logged-in browser context produces. Run a one-off login script once, save the state, then reuse it for every chaos run.

```ts
// auth-setup.ts — run once, or as a Playwright global setup
import { chromium } from "playwright";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("http://localhost:3000/login");
await page.getByLabel("Email").fill("ci@example.com");
await page.getByLabel("Password").fill(process.env.TEST_PASSWORD!);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL("**/dashboard");
await context.storageState({ path: "auth.json" });
await browser.close();
```

```bash
# Chaos-test the authenticated surface
chaosbringer --url http://localhost:3000/dashboard --storage-state auth.json
```

```ts
await chaos({
  baseUrl: "http://localhost:3000/dashboard",
  storageState: "auth.json",
});
```

The file is read by Playwright and not modified by the crawl. If the session expires mid-run, you'll see auth-redirect pages surface as errors — regenerate the state file and rerun.

## HAR record / replay

Chaosbringer can capture network traffic to a HAR file on one run and replay it on the next. A replay run is deterministic even if the backend is flaky — every request that was in the HAR gets served from the HAR, not the network.

```bash
# First run: capture responses
chaosbringer --url http://localhost:3000 --seed 42 --har-record chaos.har

# Later: replay without the server running
chaosbringer --url http://localhost:3000 --seed 42 --har-replay chaos.har
```

Programmatic:

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  har: { path: "chaos.har", mode: "record" },
});

// Replay
await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  har: { path: "chaos.har", mode: "replay", notFound: "abort" },
});
```

- `notFound: "fallback"` (default) lets unmatched URLs fall through to the real network.
- `notFound: "abort"` fails them — useful when you want to prove a run is fully deterministic.
- Fault injection rules still apply in replay mode and take precedence over HAR responses.

## Accessibility (axe-core)

Install `axe-core` as a peer and opt in with either the `invariants.axe()` preset or the `--axe` flag. Each visited page is scanned; violations are reported as invariant failures (name: `a11y-axe`), which always fail the run.

```bash
pnpm add axe-core
chaosbringer --url http://localhost:3000 --axe
chaosbringer --url http://localhost:3000 --axe --axe-tags wcag2aa,best-practice
```

```ts
import { chaos, invariants } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  invariants: [
    invariants.axe({
      tags: ["wcag2aa"],
      exclude: [".third-party-widget"],
      disableRules: ["color-contrast"],
    }),
  ],
});
```

`axe-core` is an optional peer dependency — the preset fails with a clear install hint if it isn't present. The preset is thin; drop to a custom invariant if you need multiple axe runs per page, per-URL rule overrides, or full-result capture (passes / incomplete).

A failing scan is rendered on one line: `[a11y-axe] 3 a11y violations: color-contrast(×5, serious), image-alt(×2, critical), region(×1)`. Because violations cluster by their fingerprint, a11y regressions show up in the baseline diff just like any other invariant.

## Action heatmap

Aggregate `report.actions[]` into per-target stats — count, success rate, blocked-external count, shard-skipped count — sorted by frequency. Useful when you want to know which targets the chaos driver is hitting most and which ones disproportionately fail.

```bash
chaosbringer --url http://localhost:3000 --heatmap --heatmap-top 30
chaosbringer --url http://localhost:3000 --heatmap-out heatmap.json
```

```ts
import { buildActionHeatmap, formatHeatmap, chaos } from "chaosbringer";

const { report } = await chaos({ baseUrl: "http://localhost:3000" });
const entries = buildActionHeatmap(report.actions);
console.log(formatHeatmap(entries, 20));
// entries is sorted by count desc, then failureCount desc, then key asc.
```

It's pure aggregation over the existing `actions` array — works on any report (current run, baseline, or one loaded from disk). Action types remain distinct, so `click Search` and `input Search` count separately.

## Visual regression

Compare each page's screenshot against a baseline PNG on disk. Differences beyond the configured budget are recorded as invariant violations (`visual-regression`), which fail the run.

```bash
# First run: baselines don't exist yet — chaosbringer records them and passes.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__

# Subsequent runs: compare against the recorded baselines.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__ \
  --visual-max-diff-pixels 100 \
  --visual-diff-dir ./__diffs__

# After an intentional UI change, overwrite the baselines.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__ --visual-update
```

```ts
import { chaos, invariants } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  invariants: [
    invariants.visualRegression({
      baselineDir: "./__snapshots__",
      threshold: 0.1,          // pixelmatch color distance (0..1)
      maxDiffPixels: 100,      // absolute tolerance
      maxDiffRatio: 0.001,     // or proportional tolerance
      diffDir: "./__diffs__",
    }),
  ],
});
```

- Baseline filenames are derived from each page's URL (path + query, sanitized) so different routes don't collide.
- `pixelmatch` and `pngjs` are optional peer deps — install them explicitly (`pnpm add pixelmatch pngjs`). The invariant fails with a clear install hint when they're missing.
- Dimension mismatches between baseline and current are treated as full-diff failures — resize or re-record the baseline intentionally rather than auto-accepting.
- Takes `fullPage: true` screenshots by default. Flip to viewport-only via `fullPage: false` in the programmatic API if your layout is sensitive to scroll position.
- Pair with `--device iPhone 14` to record device-specific baselines; the baseline dir is per-crawl so split baselines across devices by using different dirs.

## Performance budget

Declare a per-metric budget (in ms). Any page whose measured metric exceeds its limit is recorded as an invariant violation (`perf-budget.<metric>`), which fails the run just like any other invariant.

```bash
# CLI — comma-separated pairs, or repeat the flag
chaosbringer --url http://localhost:3000 --budget ttfb=200,fcp=1800,lcp=2500
```

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  performanceBudget: { ttfb: 200, fcp: 1800, lcp: 2500 },
});
```

Supported keys: `ttfb`, `fcp`, `lcp`, `tbt`, `domContentLoaded`, `load`. Omitted keys are not enforced. Metrics that weren't captured (e.g. `lcp` on a page that didn't render anything large) don't produce violations — only observed-and-over-limit cases do.

Budget violations are clustered by metric name, so `perf-budget.lcp` firing on 20 pages shows up as one cluster with `count: 20` in the report and the baseline diff.

## Trace record / replay / minimize

For failures that are hard to diagnose from a seed alone, record the exact sequence of visits + actions to a JSONL file, then replay or minimize that sequence.

```bash
# Record
chaosbringer --url http://localhost:3000 --seed 42 --trace-out chaos.trace.jsonl

# Replay the exact sequence (no RNG, no discovery)
chaosbringer --url http://localhost:3000 --trace-replay chaos.trace.jsonl

# Shrink the trace to the minimum subsequence that still reproduces a failure
chaosbringer minimize --url http://localhost:3000 \
  --trace chaos.trace.jsonl \
  --match "Cannot read properties of undefined" \
  --trace-out min.trace.jsonl
```

A trace is line-delimited JSON: a leading `meta` entry with the seed + baseUrl, then alternating `visit` and `action` lines. Each `action` carries the selector that was clicked (or the scroll amount, or the input target), so replay can locate the same element in a fresh page. The format version is tracked — parsing refuses traces written by incompatible future versions rather than silently misinterpreting them.

Replay skips link discovery and the RNG entirely: only URLs listed as `visit` entries are loaded, and only the recorded actions are performed. Missing selectors are logged as failed actions and the run continues.

`minimize` drives repeated replays via delta debugging (ddmin) — it keeps removing action entries and re-running as long as `--match` still fires against an error cluster. Output goes to `--trace-out` (defaults to `min.trace.jsonl`).

## Baseline diff (regression detection)

Pass a previous report to `--baseline` and the current run is diffed against it — new error clusters and newly failing pages are surfaced separately from ones that were already broken.

```bash
# First run: writes chaos-report.json as usual (no baseline yet, warns and continues)
chaosbringer --url http://localhost:3000 --baseline chaos-report.json

# Subsequent runs: compare against the prior report
chaosbringer --url http://localhost:3000 --baseline chaos-report.json --baseline-strict
```

- `--baseline <path>` — diff against this report. A missing file produces a warning, not an error (the run still writes its own report so a later invocation has a baseline to compare against).
- `--baseline-strict` — exit 1 when the diff contains new clusters or newly failing pages. Resolved / unchanged entries never fail the run.

Programmatic:

```ts
import { chaos } from "chaosbringer";

const { report, passed } = await chaos({
  baseUrl: "http://localhost:3000",
  baseline: "chaos-report.json",
  baselineStrict: true,
});

for (const c of report.diff?.newClusters ?? []) {
  console.log(`NEW [${c.type}]×${c.after}: ${c.fingerprint}`);
}
```

Clusters are matched by the same fingerprint used for `errorClusters` (URL / line:col / long numeric ids stripped), so `HTTP 500 on /api/users/42` and `HTTP 500 on /api/users/99` collapse to the same entry. Pages are matched by URL.

## GitHub Actions annotations

Opt in with `--github-annotations` and chaosbringer prints a [workflow command](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) for every error cluster and dead link. GitHub surfaces these on the Checks tab alongside test output.

```bash
chaosbringer --url http://localhost:3000 --strict --github-annotations
```

Severity maps from cluster type: invariants / exceptions / network errors / crashes are `::error`, console errors and unhandled rejections are `::warning` (upgraded to error under `--strict`). Dead links always annotate as error with the source page in the message.

## Error clustering

`CrawlReport.errorClusters` collapses repeated errors so a run with 100 identical `console.error("Failed to load X")` calls surfaces as one cluster line with `count: 100`. Each cluster is keyed by `type` + a normalised fingerprint (URLs, line:col, and long numeric ids stripped).

```
ERROR CLUSTERS
  [console]×42 [5 urls] Failed to load resource: the server responded with a status of <n> (Not Found)
  [exception]×3 fixture: boom
```

Use it to triage noisy fuzz runs — high-count clusters are the first thing to look at.

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
  chaos.expectNoDeadLinks(report);
});
```

`expectNoDeadLinks` / `chaosExpect.toHaveNoDeadLinks` surface each broken URL together with the page it was found on, so a CI failure points straight at the broken anchor without cross-referencing the full JSON report.

## Subcommands

### `minimize`

Shrink a recorded trace to the minimum subsequence of actions that still reproduces a failure. Drives ddmin (delta debugging) by repeatedly running the crawler in replay mode with subsets of the recorded actions; the reproduction predicate matches an error cluster fingerprint against a regex.

```bash
chaosbringer minimize \
  --url http://localhost:3000 \
  --trace chaos.trace.jsonl \
  --match "Cannot read properties of undefined" \
  --trace-out min.trace.jsonl
```

`--max-pages`, `--timeout`, `--ignore-analytics` are forwarded to each replay. `min.trace.jsonl` is the default output path. Visit entries are preserved — only action entries are candidates for removal.

### `flake`

Run the same crawl N times and separate error clusters into stable (fire every run) vs flaky (fire in some runs but not others); pages are split the same way by failed / clean outcome. Useful for triaging whether a failure is a real bug or a race.

```bash
chaosbringer flake --url http://localhost:3000 --runs 5 --seed 42
```

With a fixed `--seed`, RNG-driven variance is impossible, so any flake points at non-determinism outside chaosbringer (server, network, timers, or observable ordering). Pair with `--har-replay` or `--trace-replay` to narrow further. Exits 1 when any cluster / page flaked, so CI can gate on it. `--output <path>` also writes the analysis as JSON.

### `shard`

Split a crawl across N processes and merge the reports. Each worker is spawned with `--shard i/N` and hashes discovered URLs (FNV-1a) mod N; it only processes URLs whose hash matches its index, so shards do disjoint work. `baseUrl` is always processed by every shard so each has a seed for BFS.

```bash
chaosbringer shard \
  --count 4 \
  --url http://localhost:3000 \
  --seed-from-sitemap http://localhost:3000/sitemap.xml \
  --output chaos-report.json
```

All non-shard options (`--url`, `--max-pages`, `--seed`, `--baseline`, `--strict`, …) are forwarded verbatim to each worker. For full URL-space coverage, pair with `--seed-from-sitemap` — each shard filters the sitemap URLs by hash, so every URL is processed by exactly one shard. Without a sitemap, each shard only explores the subgraph reachable via owned links; deep pages reachable only through non-owned parents may go unvisited.

Exit code is the max of any worker's exit code and the merged report's (`--strict` / `--baseline-strict`). A single worker's non-zero exit still fails the overall run, even if the merged report looks clean.

You can also run shards by hand (e.g. as separate CI matrix jobs):

```bash
chaosbringer --url ... --shard 0/4 --output shard-0.json
chaosbringer --url ... --shard 1/4 --output shard-1.json
# ... then merge in Node / TS:
import { mergeReports } from "chaosbringer";
const merged = mergeReports([r0, r1, r2, r3]);
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
| `--har-record <path>` | Capture network traffic to a HAR file | — |
| `--har-replay <path>` | Replay network traffic from a HAR file | — |
| `--storage-state <path>` | Playwright storageState JSON for authenticated crawls | — |
| `--budget <k=ms,...>` | Per-metric performance budget (repeatable) | — |
| `--axe` | Enable axe-core a11y scan on every page (requires `axe-core` installed) | false |
| `--axe-tags <list>` | Comma-separated axe tags | `wcag2a,wcag2aa,wcag21a,wcag21aa` |
| `--visual-baseline <dir>` | Enable visual regression against PNG baselines in `<dir>` (requires `pixelmatch` + `pngjs`) | — |
| `--visual-threshold <n>` | pixelmatch color distance (0..1) | 0.1 |
| `--visual-max-diff-pixels <n>` | Absolute pixel budget before failing | 0 |
| `--visual-max-diff-ratio <n>` | Ratio pixel budget (0..1) | — |
| `--visual-diff-dir <dir>` | Write diff PNGs here on failure | — |
| `--visual-update` | Overwrite baselines with current screenshots (for intentional UI updates) | false |
| `--trace-out <path>` | Write a JSONL trace of visits + actions | — |
| `--trace-replay <path>` | Replay a previously recorded trace | — |
| `--device <name>` | Emulate a Playwright device (e.g. `iPhone 14`) | — |
| `--network <profile>` | CDP throttling: `slow-3g` / `fast-3g` / `offline` | — |
| `--seed-from-sitemap <url\|path>` | Prepend URLs from sitemap.xml (index-aware) | — |
| `--shard <i/N>` | Run as shard i of N. See the `shard` subcommand to spawn + merge. | — |
| `--heatmap` | Print an action-frequency heatmap after the report | false |
| `--heatmap-top <n>` | Limit the heatmap to the top N rows | 20 |
| `--heatmap-out <path>` | Write the heatmap as JSON | — |
| `--baseline <path>` | Diff this run against a previous report | — |
| `--baseline-strict` | Fail on new clusters / newly failing pages vs baseline | false |
| `--github-annotations` | Emit GitHub Actions workflow commands for each cluster / dead link | false |
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
