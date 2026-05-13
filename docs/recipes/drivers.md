# Drivers — pluggable action selection

By default the chaos crawler picks the next action with a coverage-biased weighted-random heuristic. A **driver** is a strategy object you can plug in to replace that policy: AI-guided per-step exploration, form-aware filling, scripted user journeys, adversarial payload injection, or any composition of them.

Drivers are activated by passing `driver` to `chaos()` / `ChaosCrawler`. The legacy `advisor` option still works unchanged; drivers are an addition, not a replacement.

## Built-in drivers

| Driver | What it does | When to reach for it |
|---|---|---|
| `weightedRandomDriver()` | The classic monkey-test heuristic, extracted as a Driver | Composing with other drivers as the cheap base |
| `aiDriver({ provider })` | Asks a vision model on every step what to click | Hard-to-reach UI state; AI sees screenshot + history + invariant violations |
| `formDriver()` | Detects `<form>`s, fills every supported field, submits | Apps with login / signup / settings / data-entry forms |
| `payloadDriver({ payloads })` | `formDriver` with attack payload sets (XSS / SQLi / path / large / unicode) | **Authorized** pentest of your own app; pair with invariants that detect the attack class |
| `flowDriver({ steps })` | Walks a scripted user journey (register → verify → login → …) across pages | Critical-path coverage under fault injection |

## Combinators

| Combinator | Behaviour |
|---|---|
| `compositeDriver([a, b, c])` | First child to return a non-null pick wins. Cheap drivers go last as a fallback. |
| `samplingDriver({ every, driver })` | Run `driver` once every N steps; return `null` otherwise. |
| `probabilityDriver({ probability, driver })` | Run `driver` with probability `p` per step. |
| `advisorFallbackDriver({ primary, fallback })` | Run `primary` every step, escalate to `fallback` only on stall or invariant violation. |

## Providers (model backends)

`aiDriver` needs a `DriverProvider`. Two are bundled:

- `openRouterDriverProvider({ apiKey })` — default `google/gemini-2.5-flash`.
- `anthropicDriverProvider({ apiKey })` — default `claude-haiku-4-5-20251001`.

Both return `null` on every soft failure (5xx, timeout, budget exhausted, malformed JSON) so the surrounding composite driver can fall back without branching on error.

## Recipes

### Cheap AI exploration with random fallback

```ts
import {
  aiDriver, compositeDriver, openRouterDriverProvider,
  samplingDriver, weightedRandomDriver, chaos,
} from "chaosbringer";

const ai = aiDriver({
  provider: openRouterDriverProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
  budget: { maxCalls: 50, maxUsd: 0.25 },
  goal: "exercise edge cases in checkout",
});

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    samplingDriver({ every: 3, driver: ai }),  // AI every 3rd step
    weightedRandomDriver(),                     // random fills the rest
  ]),
});
```

### Form-aware crawling

```ts
import { chaos, compositeDriver, formDriver, weightedRandomDriver } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    formDriver(),                 // when a form is on the page, fill + submit it
    weightedRandomDriver(),       // otherwise behave like the legacy crawler
  ]),
});
```

### Authorized pentest

```ts
import { chaos, compositeDriver, payloadDriver, weightedRandomDriver } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    payloadDriver({ payloads: ["xss", "sqli", "path-traversal"] }),
    weightedRandomDriver(),
  ]),
  invariants: [
    {
      name: "no-xss-fired",
      when: "afterAction",
      check: async ({ page }) =>
        (await page.evaluate(() => (window as any).__xss_fired)) ? "XSS payload executed" : true,
    },
  ],
});
```

Payload sets correspond to invariant-detectable attack classes. The XSS payloads write `window.__xss_fired = 1`; an invariant that fails when that flag is set turns a "did anything render unescaped?" question into a green/red result. SQLi-style payloads usually surface as 5xx — pair with an invariant on `page.errors` for the same effect.

### Scripted journey

```ts
import { chaos, compositeDriver, flowDriver, weightedRandomDriver } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    flowDriver({
      steps: [
        {
          name: "register",
          urlPattern: /\/signup$/,
          run: async (page) => {
            await page.fill('[name=email]', `user-${Date.now()}@example.test`);
            await page.fill('[name=password]', "P@ssw0rd!");
            await page.click('button[type=submit]');
          },
        },
        {
          name: "verify",
          urlPattern: /\/verify$/,
          run: async (page) => {
            await page.fill('[name=code]', "123456");
            await page.click('button[type=submit]');
          },
        },
        {
          name: "onboard",
          urlPattern: /\/onboarding$/,
          run: async (page) => {
            await page.click("text=Skip");
          },
        },
      ],
    }),
    weightedRandomDriver(),  // explore everywhere the flow isn't gating
  ]),
});
```

### Parallel drivers — different bug classes in one wall-clock window

```ts
import { parallelChaos, formDriver, payloadDriver, aiDriver, openRouterDriverProvider } from "chaosbringer";

const ai = aiDriver({
  provider: openRouterDriverProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
});

const out = await parallelChaos({
  base: { baseUrl: "http://localhost:3000", maxPages: 30 },
  concurrency: 3,
  shards: [
    { name: "forms",   options: { seed: 1, driver: formDriver() } },
    { name: "pentest", options: { seed: 2, driver: payloadDriver() } },
    { name: "ai",      options: { seed: 3, driver: ai } },
  ],
});

console.log(out.merged.totalErrors, "errors across all shards");
process.exit(out.exitCode);
```

Each shard runs in its own browser with its own RNG and driver instance — there is intentionally **no shared state** between shards. Budgets (`DriverBudget`, `maxUsd`) apply per-shard; if you want a strict global cap, divide it by `shards.length` up front.

## Authoring a custom driver

A `Driver` only has to implement `selectAction(step)`:

```ts
import type { Driver, DriverStep } from "chaosbringer";

const onlyClickButtons: Driver = {
  name: "buttons-only",
  async selectAction(step) {
    const button = step.candidates.find((c) => c.type === "button");
    return button ? { kind: "select", index: button.index } : null;
  },
};
```

Returning `null` means "no opinion, defer to the next driver in the composite". Returning `{ kind: "skip" }` means "deliberately do nothing this step". Returning `{ kind: "custom", perform }` lets you take over the page directly — `perform(page)` returns an `ActionResult` and counts as one chaos action.
