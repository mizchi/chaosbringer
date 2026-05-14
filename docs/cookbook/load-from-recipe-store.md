# Load-test your whole recipe library

`scenarioLoadFromStore` turns a `RecipeStore` of verified recipes into
a load workload: N workers pick one recipe per iteration, replay it
(with `requires` chained), and the usual `LoadReport` comes out the
other side — SLO + timeline + fault correlation included.

Together with **recipe templating** (`{{var}}` substitution), this
closes the gap between "we built up a skill library with AI" and "we
load-tested every flow that library covers."

## The minimum example

```ts
import { RecipeStore, scenarioLoadFromStore, formatLoadReport, assertSlo } from "chaosbringer";

const store = new RecipeStore();
// store has shop/buy-tshirt, shop/browse, shop/checkout, auth/login — all verified.

const { report } = await scenarioLoadFromStore({
  baseUrl: "http://localhost:3000",
  store,
  workers: 10,
  duration: "5m",
});

console.log(formatLoadReport(report));
assertSlo(report, {
  scenarios: { "recipe-mix": { errorRate: 0.05 } },
});
```

Each worker, on each iteration:
1. Pulls the list of currently-verified recipes (filter applied).
2. Picks one (selection strategy — default uniform).
3. If the recipe has non-sentinel `requires`, runs them in topological
   order first, deduping anything already replayed on this Page.
4. Runs the recipe. Stats land back on the store.
5. Thinks for the scenario's think-time, then loops.

The `LoadReport` has one scenario named `"recipe-mix"` (configurable
via `scenarioName`). Latency / fault timeline / throughput all behave
exactly like a hand-written `scenarioLoad` run.

## Recipe templating

Recipes can now declare `{{var}}` placeholders. Substitution happens
in three positions:

| Step kind | Templated field |
|---|---|
| `navigate` | `url` |
| `fill` | `value` |
| `select` | `value` |

Selectors, keys, click coordinates, and timeouts are **not**
templated — those are stable references that shouldn't vary per
iteration.

```json
{
  "name": "auth/signup",
  "steps": [
    { "kind": "navigate", "url": "{{base}}/signup" },
    { "kind": "fill", "selector": "[name=email]", "value": "{{email}}" },
    { "kind": "fill", "selector": "[name=password]", "value": "{{password}}" },
    { "kind": "click", "selector": "[type=submit]" }
  ]
}
```

Drive it with per-iteration vars:

```ts
await scenarioLoadFromStore({
  baseUrl: server,
  store,
  workers: 5,
  duration: "2m",
  vars: ({ workerIndex, iteration }) => ({
    base: server,
    email: `test-${workerIndex}-${iteration}@example.invalid`,
    password: "ChaosTest!2024",
  }),
});
```

Each iteration gets a fresh email. With 5 workers × 60 iterations,
that's 300 unique signups — exactly the kind of data-variation that's
painful to write in imperative `defineScenario`.

A missing variable **throws** the moment a step references it. We do
not silently substitute empty strings — a typo would otherwise let a
form submit with a blank password.

## Selection strategies

Three flavours, chosen via `selection`:

```ts
selection: "uniform"          // equal probability across every candidate
selection: "by-success-rate"  // weighted by (successCount+1)/(total+1), clamped to [0.1, 1]
selection: (cs, ctx) => cs[0] // custom function for full control
```

`"by-success-rate"` is the right default for **steady-state load
testing** of a mature library — flaky recipes get less traffic, so
production-shape failures dominate. `"uniform"` is the right default
for **library health probing** — you want every recipe exercised so
flakiness gets caught early. Switch based on context.

The custom function gets `(candidates, { workerIndex, iteration })`,
useful for round-robin or worker-pinned selection:

```ts
selection: (cs, ctx) => cs[ctx.workerIndex % cs.length],
```

## Filter for "this subset only"

```ts
await scenarioLoadFromStore({
  store,
  filter: (r) => r.preconditions[0]?.urlPattern?.includes("shop") ?? false,
  // ... → only "shop/*" recipes are eligible
});
```

Combine with `store.byDomain("github.com")` if you maintain a
multi-host library — pre-filter at the store level, post-filter at the
selection level.

## Chaining + chaos at the same time

`scenarioLoadFromStore` is just `scenarioLoad` underneath, so every
`scenarioLoad` knob is available: `faultInjection`, `runtimeFaults`,
`invariants`, `timelineBucketMs`, `storageState`. The combination
that completes the AI flywheel:

```ts
import { faults, scenarioLoadFromStore } from "chaosbringer";

await scenarioLoadFromStore({
  baseUrl: "http://localhost:3000",
  store,
  workers: 10,
  duration: "5m",
  timelineBucketMs: 1000,
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.1, name: "api-500" }),
  ],
  invariants: [/* ... */],
  vars: (ctx) => ({ email: `chaos-${ctx.workerIndex}-${ctx.iteration}@x.invalid` }),
});
```

This is the natural Phase C of the [flywheel](./ai-flywheel.md): the
AI built the library, you load-test the library under chaos, failures
feed back into `investigate()` to produce regression recipes that
join the library, next run is cheaper.

## Programmatic-only entry point

When you want to mix recipe-driven and imperative scenarios in the
same load run, use `recipeStoreScenario` directly:

```ts
import { recipeStoreScenario, scenarioLoad, defineScenario } from "chaosbringer";

const recipeMix = recipeStoreScenario({ store, selection: "by-success-rate" });
const handCheckout = defineScenario({
  name: "imperative-checkout",
  steps: [/* ... */],
});

await scenarioLoad({
  baseUrl: "http://localhost:3000",
  duration: "5m",
  scenarios: [
    { scenario: recipeMix, workers: 7 },
    { scenario: handCheckout, workers: 3 },
  ],
});
```

Now 7 workers exercise the recipe library while 3 workers hammer one
specific imperative flow — useful when you have a flow under
investigation that you want guaranteed concurrency on.

## Gotchas

- **Recipes that fail throw** to scenarioLoad, which counts the
  iteration as failed. If you'd rather a failed recipe be a soft
  signal (logged but not failure-counted), wrap the scenario step in
  a `try/catch` via a custom selection strategy that uses
  `defineScenario` directly.
- **Selection happens per iteration, not per worker.** Two workers can
  pick the same recipe at the same instant. For "round-robin without
  collisions" use a custom selection keyed on `workerIndex + iteration`.
- **`vars` are bound to one iteration.** A recipe's chain (login →
  checkout) sees the same `vars` for all links. If you need per-link
  vars, split into two iterations of single-step recipes instead.
- **The `recipe-mix` scenario reports one step**: `pick-and-replay`.
  Per-recipe step-level latency is NOT in the LoadReport — it's in
  the store's per-recipe `stats.avgDurationMs`. Use both views
  together when diagnosing.
- **Recipes captured from one host can't be replayed against another
  without templating.** Make `{{base}}` part of every captured recipe
  if you want cross-environment portability.

## Related

- The AI flywheel: [`./ai-flywheel.md`](./ai-flywheel.md)
- Recipe composition (`requires` chaining): [`./recipe-composition.md`](./recipe-composition.md)
- scenarioLoad feature doc: [`../recipes/scenario-load.md`](../recipes/scenario-load.md)
- Per-worker auth + `storageState`: [`./per-worker-auth.md`](./per-worker-auth.md) (combine with `vars` for fully-isolated workers)
