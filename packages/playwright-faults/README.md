# @mizchi/playwright-faults

Playwright fault-injection primitives at three layers, extracted from chaosbringer:

| Layer | API surface | Where |
|---|---|---|
| Network | `FaultRule` + `faults.{status, abort, delay}` builders | Playwright `route()` |
| Page lifecycle | `LifecycleFault` + `compileLifecycleFaults` + `PlaywrightLifecycleExecutor` | Playwright `Page` / `BrowserContext` / CDP at named stages |
| JS runtime | `RuntimeFault` + `compileRuntimeFaults` + `buildRuntimeFaultsScript` | Playwright `addInitScript` per page nav |

## Install

```bash
pnpm add @mizchi/playwright-faults
pnpm add playwright   # peer
```

Requires Node 20+.

## Network-level faults (FaultRule)

```ts
import { faults } from "@mizchi/playwright-faults";

const rules = [
  faults.status(500, { urlPattern: /\/api\// }),
  faults.abort({ urlPattern: /tracking/ }),
  faults.delay(2000, { urlPattern: /\/api\// }),
];

// Wire into Playwright's route() yourself, or pass to chaosbringer:
//   new ChaosCrawler({ baseUrl, faultInjection: rules })
```

## Page-lifecycle faults

```ts
import {
  PlaywrightLifecycleExecutor,
  compileLifecycleFaults,
  executeLifecycleAction,
  lifecycleFaultsAtStage,
  shouldFireProbability,
} from "@mizchi/playwright-faults";

const compiled = compileLifecycleFaults([
  { when: "afterLoad", action: { kind: "clear-storage", scopes: ["localStorage"] } },
  { when: "betweenActions", action: { kind: "cpu-throttle", rate: 4 } },
]);

const executor = new PlaywrightLifecycleExecutor(page, browserContext);
for (const cf of lifecycleFaultsAtStage(compiled, "afterLoad", url)) {
  if (shouldFireProbability(cf.fault.probability, rng)) {
    await executeLifecycleAction(executor, cf.fault.action);
  }
}
```

## JS-runtime faults (addInitScript)

```ts
import { buildRuntimeFaultsScript, compileRuntimeFaults, mergeRuntimeStats } from "@mizchi/playwright-faults";

const compiled = compileRuntimeFaults([
  { action: { kind: "flaky-fetch", rejectionMessage: "synthetic network error" }, probability: 0.1 },
  { action: { kind: "clock-skew", skewMs: 10 * 60 * 1000 } },
]);

await page.addInitScript(buildRuntimeFaultsScript(compiled, seed));

// After navigations: drain per-page stats and merge
const pageStats = await page.evaluate(() => globalThis.__chaosbringerRuntimeStats);
mergeRuntimeStats(compiled, pageStats);
```

## RNG contract

Functions that need randomness (`shouldFireProbability`, etc.) accept any object with `next(): number` returning `[0, 1)`. Bring your own — chaosbringer uses its seeded mulberry32; vitest tests can pass `Math.random`-flavor stubs.

## License

MIT
