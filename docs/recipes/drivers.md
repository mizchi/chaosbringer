# Drivers — pluggable action selection

By default the chaos crawler picks the next action with a coverage-biased weighted-random heuristic. A **driver** is a strategy object you can plug in to replace that policy: AI-guided per-step exploration, form-aware filling, scripted user journeys, adversarial payload injection, or any composition of them.

Drivers are activated by passing `driver` to `chaos()` / `ChaosCrawler`. The legacy `advisor` option still works unchanged; drivers are an addition, not a replacement.

## Built-in drivers

| Driver | What it does | When to reach for it |
|---|---|---|
| `weightedRandomDriver()` | The classic monkey-test heuristic, extracted as a Driver | Composing with other drivers as the cheap base |
| `aiDriver({ provider })` | Asks a model on every step what to click | Hard-to-reach UI state; the model sees the candidates with their geometry, history, invariant violations, and a screenshot if it asks |
| `formDriver()` | Detects `<form>`s, fills every supported field, submits | Apps with login / signup / settings / data-entry forms |
| `payloadDriver({ payloads })` | `formDriver` with attack payload sets (XSS / SQLi / path / large / unicode) | **Authorized** pentest of your own app; pair with invariants that detect the attack class |
| `flowDriver({ steps })` | Walks a scripted user journey (register → verify → login → …) across pages | Critical-path coverage under fault injection |
| `perfSeekingDriver({ prior?, epsilon? })` | Weights candidates by what their perfKey cost earlier (the larger of `blockingMs` and `interactionMs`, in log-scale buckets), exploring untried ones. A seed replays the same picks as long as no key's mean cost crosses into another bucket | Hunting the slowest interaction; needs `perf` on. See [perf.md](perf.md#steering-the-crawl-by-cost-lastactionperf-and-perfseekingdriver) |

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

### Writing a provider

A provider is handed the facts the scrape measured, not a rendering of them. `input.candidates` is a `DriverProviderCandidate[]` — the shape a hand-written `Driver` sees in `step.candidates`, minus the `selector`, which stays on this side of the seam because the answer is an `index` into that array. So `type` and the hit-test geometry are there, and `isObstructed` works from inside a provider:

```ts
import { isObstructed, type DriverProvider } from "chaosbringer";

const textOnly: DriverProvider = {
  name: "text-only",
  async selectAction(input) {
    // The description reads `button "Continue"` whether or not the click
    // lands. The geometry is what says which.
    const live = input.candidates.filter((c) => !isObstructed(c));
    const pool = live.length > 0 ? live : input.candidates;
    const target = pool.find((c) => c.type === "button") ?? pool[0];
    return target ? { index: target.index, reasoning: "first live button" } : null;
  },
};
```

`input.screenshot` is a thunk, not bytes. `await input.screenshot()` captures; a provider that never calls it never pays for a capture. The mode defaults to the driver's `screenshotMode`, and passing one (`input.screenshot("fullPage")`) overrides it for that call. Each call captures, so call it once.

A capture that fails throws out of the thunk. In a provider that already collapses its failures to `null` that needs no extra handling — the driver stands down and the composite falls through, the same as for a 5xx.

The advisor seam matches: `AdvisorCandidate` carries `type` and the same geometry, and `ctx.screenshot` is a thunk whose failure becomes that consult's soft failure.

With `perf` on, `input.lastActionPerf` says what the previous action cost: its duration, main-thread blocking, interaction latency when the browser reported one, and requests. It is `DriverStep.lastActionPerf` without its `key`, because the key embeds the selector. It is absent (not zeroed) when nothing was measured. The bundled providers render it as one line under the history, and without it they render exactly the prompt they always did. `ctx.lastActionPerf` on the advisor seam is the same fact, with the key, and the bundled advisor leaves the key out of its prompt too.

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

### Fall back when the model is unsure

Providers return a confidence with the pick. A model that is about to pick badly often says so while doing it — reporting 0.4 on the third attempt at the same disabled button — so `minConfidence` turns that into a fallback rather than asking the model a better question:

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver([
    aiDriver({ provider, minConfidence: 0.5 }),  // hesitant picks stand down
    weightedRandomDriver(),                       // which lets breadth take the step
  ]),
});
```

A dropped pick still costs the call that produced it — only the answer is declined, not the spend. Providers that report no confidence are never gated: there is no signal, and reading silence as zero would disable the driver. The confidence that *is* reported lands on the trace entry (`advisor.confidence`), so a run can be audited for where it started guessing.

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

### Setting a dropdown

A `select` candidate is one the crawler will set with `selectOption`, not click — clicking a native `<select>` opens its list and selects nothing. It carries `selectValue`: the option the crawler will set if you pick it, chosen as the first value the page offers that is not the one already selected.

```ts
const useExpress: Driver = {
  name: "express",
  async selectAction(step) {
    const shipping = step.candidates.find(
      (c) => c.type === "select" && c.description.includes("shipping"),
    );
    // `selectValue` is what picking this would set. An index alone does
    // not say — picking a dropdown asks for a value.
    return shipping?.selectValue ? { kind: "select", index: shipping.index } : null;
  },
};
```

- **A placeholder and a disabled option are never offered.** `""` would set the dropdown to nothing and read in the report as an action that did something; Playwright refuses a disabled option outright.
- **`selectValue` is absent when there is nothing to set** — a dropdown already on its only real option. Picking it is then skipped rather than attempted, the same as a non-visible target.
- The action is recorded as `type: "select"` with `value` set, which is the one action whose value the trace carries: an option value came off the page rather than out of a generator. A recipe replays it with no `fillValueFor` hook.

### Emptying a field

A `select` **pick** normally names an element and nothing else: the crawler performs the action the candidate's own `type` implies, and for an `input` that is a fill with a value derived from the field's `inputType` — always a non-empty one. (The pick kind and the candidate type share the word; `kind: "select"` means "act on this candidate", `type: "select"` means "this candidate is a dropdown".)

`operation: "clear"` is the exception, and the one state a pick could not otherwise reach:

```ts
const emptyThenSubmit: Driver = {
  name: "empty-then-submit",
  async selectAction(step) {
    const field = step.candidates.find((c) => c.type === "input");
    return field ? { kind: "select", index: field.index, operation: "clear" } : null;
  },
};
```

It is a `clear()`, so it needs a candidate with `type: "input"` — the class `fill()` accepts. On anything else the pick is refused the way an out-of-range index is: the step is not spent, and the driver is asked again.

`boundaryValueProvider` already offers `""` as a value worth trying, but that reaches a field through `formDriver`, which writes **every** field of a form at once. "Empty this one field and leave the rest valid" is the case neither path expressed — the shape that finds a form validating on `input` and caching the answer.

The action is reported as `type: "clear"` rather than `"input"`, because a trace carries no fill value: with one label for both, a report cannot say whether a step put text into a field or took it out. A recorded crawl replays it as a `fill` with an empty value — unlike a `select`, whose value the trace does carry, a clear has only one possible value so there is nothing to record.

`weightedRandomDriver` never emits it, so no existing crawl changes behaviour.

### What a step guarantees

- **`step.candidates` is re-collected from the DOM before every step**, so an index is only valid for the step that handed it to you. Do not cache the list across steps: on an app that re-renders in place — hash or History routing, a modal, a wizard — the controls change without a page visit, and last step's index names a different element than it did.
- **Re-collecting only helps if the screen has changed by then.** Under the default `settle: "networkidle"` a click that only fires an XHR is not waited for: the next step starts about 100 ms later, before a slow response has rendered, so its candidates do not include what the XHR adds, and a link picked meanwhile aborts the request, which the report lists as a `net::ERR_ABORTED` network cluster. With `settle: "adaptive"` (`--settle adaptive`) each step waits for the page's requests to finish, so the next step sees what they rendered and the abort does not happen. In one probe, a driver reached two XHR-rendered links in 5 of 5 seeds under adaptive and 1 of 5 under `networkidle`. See [settling](perf.md#settling-between-steps---settle), including what adaptive does not wait for.
- **`step.url` is the URL of the page *visit*** and holds still for every step on that page; budgets and `onPageStart` key off it. **`step.currentUrl` is where the app has actually routed to** as of this step. Group by `url`, decide on `currentUrl`.
- **A form field's description falls back to its `name` attribute** when it has neither text nor an `aria-label`, which is the usual case: without it two fields on one page both read `(input)`.
- **Every candidate carries geometry**: `bbox`, `inViewport`, `inert` (`pointer-events: none`), and `coveredBy`. Absent only on the `scroll` target and on a page the scrape could not read.
- **`step.lastActionPerf` is what the previous action on this page cost**, present only with `perf` on and only once an action on the page was measured. Its `key` is that action's perfKey, and `candidatePerfKey(step, candidate)` gives the key a candidate's span will carry (it follows `step.currentUrl`, the route the page is on, which after a navigating click is not the visit's `step.url`), so a driver can join the two. See [perf.md](perf.md#steering-the-crawl-by-cost-lastactionperf-and-perfseekingdriver) for what is measured when.

### Skipping a control the click will not reach

A description cannot say whether a click lands. `button "Continue"` reads identically whether the button is live or sitting under a consent backdrop that eats the click — and a click on a covered control silently does nothing, so a driver retries it for as long as it has budget. `isObstructed` reads the geometry the scrape already measured:

```ts
import { isObstructed, type Driver } from "chaosbringer";

const liveOnly: Driver = {
  name: "live-only",
  async selectAction(step) {
    const live = step.candidates.filter((c) => !isObstructed(c));
    // Fall back to the full list rather than returning null: a screen whose
    // every control is blocked still has to be leavable.
    const pool = live.length > 0 ? live : step.candidates;
    const pick = pool.find((c) => c.type === "button") ?? pool[0];
    return pick ? { kind: "select", index: pick.index } : null;
  },
};
```

Two things to know before reading `coveredBy` yourself:

- **`inViewport: false` is not a reason to skip.** Playwright scrolls an element into view before acting on it, so an off-screen control is perfectly clickable. It *is* the condition under which `coveredBy` was measured, which is why an absent `coveredBy` means "nothing found on top" rather than "nothing is on top". `isObstructed` gets that right; a bare `c.coveredBy === undefined` check does not.
- **It answers on positive evidence only.** A false "obstructed" makes a driver skip a control that works, which is worse than the wasted step it was avoiding — so unknown is reported the same as fine.

Measured on a gated-checkout SPA carrying a transparent full-screen backdrop left behind by a styled-away tip card: of 13 steps that changed nothing, this flagged 12, and all 12 were real dead clicks. The confidence the model reported on those same picks was 0.99 or above — nothing in the description gave it anything to be unsure about. Pruning the blocked candidates also shortens the prompt, so the run was 13% cheaper in tokens than sending them.
