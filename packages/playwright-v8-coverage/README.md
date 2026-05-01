# @mizchi/playwright-v8-coverage

V8 precise-coverage collector for Playwright via CDP (`Profiler.takePreciseCoverage`), with novelty-scoring helpers. Extracted from chaosbringer where it powers AFL-style coverage-guided action selection.

## Install

```bash
pnpm add @mizchi/playwright-v8-coverage
# also requires playwright as a peer
pnpm add playwright
```

Requires Node 20+.

## Usage

```ts
import { chromium } from "playwright";
import { CoverageCollector, coverageDelta } from "@mizchi/playwright-v8-coverage";

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const cdp = await ctx.newCDPSession(page);
const collector = new CoverageCollector(cdp);
await collector.start();

await page.goto("https://example.com");
const before = await collector.take();

await page.click("button#open-drawer");
const after = await collector.take();

const novel = coverageDelta(before, after);
console.log(`drawer click executed ${novel.size} new functions`);

await collector.stop();
await browser.close();
```

## Public API

### `CoverageCollector`

```ts
class CoverageCollector {
  constructor(cdp: CDPSession);
  start(): Promise<void>;        // Profiler.enable + startPreciseCoverage
  take(): Promise<Set<string>>;  // snapshot of executed function fingerprints
  stop(): Promise<void>;         // Profiler.stopPreciseCoverage
}
```

`take()` returns a `Set<string>` of function fingerprints `<scriptUrl> <functionName> <startOffset>`. Counters accumulate across `take()` calls — diff against a previous snapshot to get per-action deltas.

### `coverageSignature(scripts) -> Set<string>`

Convert a raw V8 precise-coverage snapshot into the fingerprint set. Useful when you already have the CDP response from elsewhere.

### `coverageDelta(prev, next) -> Set<string>`

Set difference: elements of `next` not in `prev`.

### `noveltyMultiplier(score, boost) -> number`

`1 + boost · log(1 + score)`. Logarithmic so a target with a huge historical contribution doesn't crush every other target's weight. `boost: 0` disables (returns 1).

### `summarizeCoverage(state) -> CoverageReport`

Build a report-shaped summary from running coverage state (totalFunctions, pagesWithNewCoverage, topNovelTargets).

### `targetKey(url, selector) -> string`

Stable map key for a `(url, selector)` pair. Used as the key in per-target novelty maps.

## License

MIT
