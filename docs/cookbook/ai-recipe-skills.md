# Grow an AI skill library (Goals + Recipes)

`recipeDriver` + `RecipeStore` build a JSON-backed "skill library" on
top of the existing `aiDriver`. The AI handles unknown UIs; once a
trajectory succeeds K times, it's promoted into a recipe and replayed
without LLM calls thereafter. Cost per run drops as the library grows.

## The three personas (`Goal`)

```ts
import { goals, completionByUrl } from "chaosbringer";

// "Normal user trying to finish a task"
const buyShirt = goals.completion({
  task: "Add any T-shirt to the cart and complete checkout",
  successCheck: completionByUrl("/thanks"),
});

// "Adversarial tester trying to break things"
const breakIt = goals.bugHunting({
  focus: "the checkout flow",   // optional hint surfaced to the LLM
});

// "Systematic explorer maximising UI coverage"
const explore = goals.coverage({ targetSelectors: 30 });
```

Each `Goal` becomes the `objective` string an AI driver consumes plus a
poll-able `successCheck` that decides "we're done".

## Recipe lifecycle

```
AI Driver runs → trace captured → extractCandidate() → candidate Recipe
                                                         ↓
                          verifyAndPromote() (K runs)   →  verified Recipe
                                                         ↓
                          recipeDriver tries it FIRST   →  no LLM call
                                                         ↓
                          replay fails repeatedly       →  demoted
```

## Set up the store

```ts
import { RecipeStore } from "chaosbringer";

const store = new RecipeStore({
  localDir: "./chaosbringer-recipes",   // commit to git
  globalDir: "~/.chaosbringer/recipes", // optional cross-project library
  minRuns: 5,                            // need ≥ 5 runs to decide
  minSuccessRate: 0.8,                   // 4/5 to promote
});
store.load();
```

Two-tier lookup: local recipes override global by name, so a project can
shadow a shared recipe without rewriting it.

## Use existing recipes in a crawl

```ts
import { chaos, compositeDriver, aiDriver, anthropicDriverProvider, recipeDriver, weightedRandomDriver } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  driver: compositeDriver({
    drivers: [
      // 1. Try a verified recipe first — zero LLM cost when it matches.
      recipeDriver({ store, goal: "completion" }),
      // 2. Fall back to the AI driver for steps no recipe covers.
      aiDriver({
        provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
        goal: buyShirt.objective,
      }),
      // 3. Last resort — random click, so the crawl never stalls.
      weightedRandomDriver(),
    ],
  }),
});
```

When `recipeDriver` returns a `custom` pick, the crawler runs the recipe
and records success/failure on it. Stats update in-place; once the success
rate crosses the threshold, the status flips to `verified` automatically.

## Capture a candidate from a successful trajectory

```ts
import { extractCandidate, type ActionTrace } from "chaosbringer";

const trace: ActionTrace = {
  goal: "completion",
  steps: [
    { kind: "navigate", url: "http://localhost:3000/" },
    { kind: "click", selector: "[data-test=tshirt]" },
    { kind: "click", selector: "[data-test=add-to-cart]" },
    { kind: "click", selector: "[data-test=checkout]" },
  ],
  startState: { url: "http://localhost:3000/" },
  endState: { url: "http://localhost:3000/thanks" },
  durationMs: 4200,
  successful: true,
};

const candidate = extractCandidate(trace, {
  name: "shop/buy-tshirt",
  description: "Add a T-shirt and check out as an anonymous user",
});
store.upsert(candidate);
```

URL preconditions are auto-inferred from the trace's start/end URLs.
Pass `extraPreconditions` to tighten (e.g. "this only applies when the
cart icon is visible").

## Verify a candidate

```ts
import { verifyAndPromote } from "chaosbringer";
import { chromium } from "playwright";

const browser = await chromium.launch();

await verifyAndPromote(store, candidate, {
  runs: 5,
  minSuccessRate: 0.8,
  setupPage: async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    return { page, cleanup: () => context.close() };
  },
  verbose: true,
});

await browser.close();
```

5/5 success → promoted to `verified`, immediately usable by `recipeDriver`.
2/5 or fewer → demoted. In between → stays a candidate (probably needs more
data or a tighter precondition).

## Recipe step format

Recipes are JSON. The step set is intentionally narrow so they're safe
to share across projects without arbitrary code execution:

```json
{
  "name": "shop/buy-tshirt",
  "description": "Add any T-shirt to the cart and complete checkout",
  "goal": "completion",
  "preconditions": [{ "urlPattern": "^http://localhost:3000/" }],
  "steps": [
    { "kind": "click", "selector": "[data-test=tshirt]",
      "expectAfter": { "hasSelector": "[data-test=variant-picker]" } },
    { "kind": "click", "selector": "[data-test=add-to-cart]" },
    { "kind": "click", "selector": "[data-test=checkout]",
      "expectAfter": { "urlContains": "/checkout", "timeoutMs": 3000 } }
  ],
  "postconditions": [{ "urlPattern": "/thanks" }],
  "stats": { "successCount": 7, "failCount": 1, "avgDurationMs": 4231,
             "lastSuccessAt": 1715000000000, "lastFailAt": null, "maxDurationMs": 5102 },
  "status": "verified",
  "version": 1,
  "origin": "ai-extracted"
}
```

Allowed step kinds: `navigate`, `click`, `fill`, `press`, `select`,
`wait`, `waitFor`. No `evaluate` / arbitrary JS — a bad capture should
not become a remote-code-execution vector.

## Gotchas

- **Recipes are per-goal.** `recipeDriver({ store, goal: "completion" })`
  only fires recipes captured under that goal. Recipes without a `goal`
  field are eligible for every goal (use sparingly — they couple a
  shopping flow to a bug-hunting run).
- **Preconditions are checked with a 100ms timeout.** A precondition
  selector that takes 2s to appear will never match. If your recipe needs
  to wait for an SPA bootstrap, put a `waitFor` as the first step
  *after* preconditions match.
- **Recipes don't compose automatically.** `requires: ["auth/login"]` is
  metadata — the driver does not chain. Either inline the prerequisite
  steps or run the prerequisite recipe explicitly before the dependent one.
- **The store is process-local during a run.** Two parallel CI shards
  writing to the same `localDir` race. For parallel runs, point each
  shard at a different `localDir` and merge afterwards.
- **`hand-written` recipes still get stats.** Origin is metadata; every
  recipe goes through the same promotion/demotion pipeline. Set
  `status: "verified"` on the recipe object when you upsert to skip the
  verification dance for a recipe you trust.

## Related

- Existing driver framework: [`docs/recipes/drivers.md`](../recipes/drivers.md)
- Choosing which Driver to compose: [`./fault-layer-cheatsheet.md`](./fault-layer-cheatsheet.md) (similar decision style)
- A runnable demo: [`examples/recipe-skills/`](../../examples/recipe-skills/)
