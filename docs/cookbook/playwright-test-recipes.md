# Use recipes inside `@playwright/test`

Mirror of the existing `chaos` fixture (closes [#91](https://github.com/mizchi/chaosbringer/issues/91)). Lets PW Test users replay recipes, harvest page-declared scenarios, and run `investigate()` without wiring the recipe layer manually each test.

## Quickstart

```ts
import { recipesTest, expect } from "chaosbringer/fixture";

recipesTest("buy flow", async ({ runRecipe }) => {
  await runRecipe("shop/buy-tshirt", { vars: { email: "alice@example.com" } });
});
```

That's it — `recipesTest` is `@playwright/test`'s `base.extend()` with the recipes fixture pre-applied.

## Available fixtures

| Fixture | Type | What |
|---|---|---|
| `store` | `RecipeStore` | Shared store instance. Default `localDir: "./chaosbringer-recipes"`. Reused across tests so `beforeAll` can populate it once. |
| `runRecipe` | `(name, opts?) => Promise<void>` | Replay a verified recipe. Honours `requires` chaining by default. Throws on store-miss or replay failure. |
| `harvestPageScenarios` | `(opts?) => Promise<ActionRecipe[]>` | Read `window.__chaosbringer` on the current page, upsert any found scenarios, return them. |
| `investigate` | `(failure, opts) => Promise<InvestigateResult>` | Phase D investigator. Requires a `driver` (typically `aiDriver({ provider: anthropicDriverProvider(...) })`). |

## Extending an existing test base

When your suite already extends `base` for other reasons:

```ts
import { test as base } from "@playwright/test";
import { withRecipes, type RecipesFixtures } from "chaosbringer/fixture";

export const test = base.extend<RecipesFixtures>(withRecipes({
  store: {
    localDir: "./tests/recipes",   // override default location
  },
}));

test("checkout flow", async ({ page, runRecipe, store }) => {
  // ... use both `page` and the recipes fixtures
});
```

Pass a pre-built `RecipeStore` via `storeInstance` if you want a singleton across many test files:

```ts
const sharedStore = new RecipeStore({ localDir: "./tests/recipes" });
sharedStore.load();

export const test = base.extend<RecipesFixtures>(withRecipes({ storeInstance: sharedStore }));
```

## `runRecipe` options

```ts
test("data-driven signup", async ({ runRecipe }) => {
  for (const email of TEST_EMAILS) {
    await runRecipe("auth/signup", {
      vars: { email, password: "ChaosTest!2024" },
      // chainRequires: false   // skip auth/login etc. for this run
      // snapshot: true          // enable storage-state snapshot fast-path
    });
  }
});
```

## Harvesting page-declared scenarios

When the app self-declares scenarios on `window.__chaosbringer` (see [browser-harness concepts](./browser-harness-concepts.md)):

```ts
test("harvest + replay", async ({ page, harvestPageScenarios, runRecipe }) => {
  await page.goto("/");
  const harvested = await harvestPageScenarios({ trustPublisher: true });
  expect(harvested.length).toBeGreaterThan(0);

  // `trustPublisher: true` promoted them to verified; replay directly.
  await runRecipe(harvested[0].name);
});
```

## Investigating a failure inside a test

```ts
import { aiDriver, anthropicDriverProvider } from "chaosbringer";

test("investigate a captured failure", async ({ investigate }) => {
  const result = await investigate(
    {
      url: "http://localhost:3000/broken",
      signature: "catalog-500",
      errorMessages: ["CatalogWidget failed"],
    },
    {
      driver: aiDriver({
        provider: anthropicDriverProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      }),
      budget: 15,
      minimize: true,
    },
  );

  expect(result.reproduced).toBe(true);
  expect(result.recipe!.origin).toBe("regression");
});
```

## Gotchas

- **`investigate` opens its own `BrowserContext`.** Don't reuse `page` from the test inside the failure handler — the runner expects to start fresh.
- **`runRecipe` doesn't return a value.** Throw-on-failure is the only signal — wrap in `try/catch` if you want soft handling.
- **`harvestPageScenarios` auto-upserts** harvested entries into the store. Pass `trustPublisher: true` to skip the verify dance; otherwise they enter as `candidate`.
- **The store is module-shared.** Two test files using `recipesTest` see the same in-memory cache. Use `withRecipes({ store: { localDir: ... } })` per file for isolation, or call `store.delete()` in cleanup.
- **Playwright's parallel mode runs files in separate processes.** Each process gets its own `sharedStore` — so cross-file accumulation only happens within one worker. Persist via the on-disk store if you need cross-worker stats.

## Related

- The chaos fixture (different concern — single-page chaos run): inline in `chaosbringer/fixture` as `chaosTest` / `withChaos`.
- The runnable demo: [`examples/playwright-test/tests/recipes.spec.ts`](../../examples/playwright-test/tests/recipes.spec.ts).
- AI flywheel — investigate flow: [`./ai-flywheel.md`](./ai-flywheel.md)
