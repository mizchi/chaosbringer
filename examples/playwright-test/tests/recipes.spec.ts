/**
 * Recipes fixture inside a Playwright Test suite.
 *
 * Demonstrates three patterns (matching the chaos.spec.ts shape):
 *
 * 1. `recipesTest` — the fixture directly. Use when recipes are the
 *    primary thing the file does.
 * 2. `withRecipes()` — extend an existing `test`. Use when you have a
 *    regular Playwright Test file and want recipes as one tool.
 * 3. `runRecipe()` with `{{var}}` templating — data-driven replays.
 */

import { test as base, expect } from "@playwright/test";
import { recipesTest, withRecipes, type RecipesFixtures } from "chaosbringer/fixture";
import { type ActionRecipe, emptyRecipeStats } from "chaosbringer";

const BASE = `http://localhost:${process.env.PORT ?? 3300}`;

/**
 * Seed an in-memory recipe so the demo runs without a pre-populated
 * `chaosbringer-recipes/` directory. Real usage would either commit
 * recipes into git or harvest them at start-up via
 * `harvestPageScenarios()`.
 */
function seedHomeRecipe(): ActionRecipe {
  return {
    name: "site/visit-about",
    description: "Click About link from home",
    preconditions: [{ urlPattern: "^http://localhost:" }],
    steps: [
      { kind: "navigate", url: BASE, expectAfter: { hasSelector: "h1" } },
      {
        kind: "click",
        selector: 'a[href="/about"]',
        expectAfter: { urlContains: "/about", timeoutMs: 3000 },
      },
    ],
    postconditions: [{ urlPattern: "/about" }],
    requires: [],
    stats: emptyRecipeStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- pattern 1: recipesTest directly ----------

recipesTest.beforeEach(({ store }) => {
  store.upsert(seedHomeRecipe());
});

recipesTest("runs a verified recipe end-to-end", async ({ page, runRecipe }) => {
  await runRecipe("site/visit-about");
  expect(page.url()).toContain("/about");
});

recipesTest("harvests scenarios the page self-declares", async ({ page, harvestPageScenarios, store }) => {
  // The site/ fixture in this example doesn't publish scenarios on
  // window.__chaosbringer, so the harvest returns []. The point of
  // this test is that the call is wired and doesn't throw.
  await page.goto(BASE);
  const harvested = await harvestPageScenarios();
  expect(harvested).toEqual([]);
  // Pre-seeded recipe still in the store.
  expect(store.get("site/visit-about")).not.toBeNull();
});

// ---------- pattern 2: withRecipes() on a custom base ----------

const customTest = base.extend<RecipesFixtures>(withRecipes());

customTest.beforeEach(({ store }) => {
  store.upsert(seedHomeRecipe());
});

customTest("extending base.test with recipes fixture", async ({ page, runRecipe }) => {
  await runRecipe("site/visit-about");
  expect(page.url()).toContain("/about");
});

// ---------- pattern 3: templated recipe driven per-test ----------

recipesTest("templated recipe drives different start URLs", async ({ page, store, runRecipe }) => {
  store.upsert({
    ...seedHomeRecipe(),
    name: "site/visit-templated",
    steps: [
      { kind: "navigate", url: "{{base}}", expectAfter: { hasSelector: "h1" } },
      {
        kind: "click",
        selector: 'a[href="/about"]',
        expectAfter: { urlContains: "/about", timeoutMs: 3000 },
      },
    ],
  });
  await runRecipe("site/visit-templated", { vars: { base: BASE } });
  expect(page.url()).toContain("/about");
});
