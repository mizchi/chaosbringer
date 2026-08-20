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
  // Held open and never answered — the caller's promise never settles.
  // Without releaseAfterMs the route stays parked until the page closes.
  faults.hang({ urlPattern: /\/api\/slow/, releaseAfterMs: 5000 }),
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
  { action: { kind: "reject-fetch", rejectAs: "AbortError" }, probability: 0.1 },
  // fetch resolves; res.json() rejects — the most commonly missed catch.
  { action: { kind: "reject-body" }, urlPattern: /\/api\/cart$/ },
  // Promise never settles, no request issued: exposes missing timeouts.
  { action: { kind: "never-settle-fetch" }, urlPattern: /\/api\/slow$/ },
  { action: { kind: "clock-skew", skewMs: 10 * 60 * 1000 } },
]);

await page.addInitScript(buildRuntimeFaultsScript(compiled, seed));

// After navigations: drain per-page stats and merge
const pageStats = await page.evaluate(() => globalThis.__chaosbringerRuntimeStats);
mergeRuntimeStats(compiled, pageStats);
```

`urlPattern` is matched against the **request URL** for fetch-scoped kinds
(`flaky-fetch`, `reject-fetch`, `never-settle-fetch`, `reject-body`,
`resolve-rejected-thenable`) and against `location.href` for page-scoped ones
(`clock-skew`).

## Deterministic schedules

Every layer accepts `schedule` in place of `probability`: a decision table
indexed by how many times the fault has already matched.

```ts
import { decideFault, validateFaultSchedule } from "@mizchi/playwright-faults";

const rule = faults.status(500, {
  urlPattern: /\/api\/cart$/,
  schedule: { decisions: ["inject", "pass"], afterEnd: "pass" },
});

// Node-side layers evaluate it with decideFault(rule, occurrence, rng);
// in-page scripts embed the generated twin (buildDecisionHelperSource()),
// which is asserted to agree case-for-case.
decideFault(rule, 0, rng); // "inject"
decideFault(rule, 1, rng); // "pass"
```

`afterEnd`: `"pass"` (default, spent), `"inject"` (keep firing), `"repeat"`
(cycle). Setting both `probability` and `schedule` throws — call
`validateFaultSchedule` from your own compile step if you accept user config.
A schedule draws no random numbers, so it never shifts a seeded sequence.

## RNG contract

Functions that need randomness (`shouldFireProbability`, etc.) accept any object with `next(): number` returning `[0, 1)`. Bring your own — chaosbringer uses its seeded mulberry32; vitest tests can pass `Math.random`-flavor stubs.

## License

MIT
