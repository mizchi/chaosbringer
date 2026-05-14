/**
 * Playwright Test Fixture for Chaos Testing
 *
 * Usage:
 * ```typescript
 * import { test, expect } from '@playwright/test';
 * import { chaosTest, withChaos } from 'chaosbringer/fixture';
 *
 * // Option 1: Use chaosTest directly
 * chaosTest('chaos test homepage', async ({ page, chaos }) => {
 *   const result = await chaos.testPage(page, 'http://localhost:3000');
 *   expect(result.errors).toHaveLength(0);
 * });
 *
 * // Option 2: Extend your existing test
 * const test = base.extend(withChaos());
 * test('my test', async ({ page, chaos }) => { ... });
 * ```
 */

import { test as base, expect, type Page } from "@playwright/test";
import { ChaosCrawler, COMMON_IGNORE_PATTERNS } from "./crawler.js";
import type { ChaosTestOptions, PageResult, CrawlReport } from "./types.js";
import { runRecipeWithRequires } from "./recipes/composition.js";
import { investigate as runInvestigate, type InvestigateResult } from "./recipes/investigate.js";
import { loadPageScenarios } from "./recipes/page-scenarios.js";
import { runRecipe as replayRecipe } from "./recipes/replay.js";
import {
  RecipeStore,
  type RecipeStoreOptions,
} from "./recipes/store.js";
import type { RecipeVars } from "./recipes/templating.js";
import type { ActionRecipe } from "./recipes/types.js";
import type { FailureContext } from "./recipes/goals.js";
import type { SnapshotPolicy } from "./recipes/composition.js";

export interface ChaosFixture {
  /** Test a single page with chaos testing */
  testPage(page: Page, url: string): Promise<PageResult>;

  /** Crawl multiple pages starting from a URL */
  crawl(startUrl: string): Promise<CrawlReport>;

  /** Assert no errors were found */
  expectNoErrors(result: PageResult | CrawlReport): void;

  /**
   * Assert the crawl discovered no dead links. Prints each dead link's
   * source page so the reviewer can find the broken anchor without
   * cross-referencing the full report.
   */
  expectNoDeadLinks(result: CrawlReport): void;

  /** Get the underlying crawler instance */
  crawler: ChaosCrawler;
}

export interface ChaosFixtures {
  chaos: ChaosFixture;
  chaosOptions: ChaosTestOptions;
}

/**
 * Create chaos fixture with custom options
 */
export function withChaos(defaultOptions: ChaosTestOptions = {}) {
  return {
    chaosOptions: [{}, { option: true }] as [ChaosTestOptions, { option: true }],

    chaos: async (
      { page, chaosOptions }: { page: Page; chaosOptions: ChaosTestOptions },
      use: (fixture: ChaosFixture) => Promise<void>
    ) => {
      const options = { ...defaultOptions, ...chaosOptions };

      // Get base URL from playwright config or options
      const baseUrl = options.baseUrl || page.context().pages()[0]?.url() || "http://localhost:3000";

      const crawler = new ChaosCrawler({
        baseUrl,
        maxPages: options.maxPages ?? 10,
        maxActionsPerPage: options.maxActionsPerPage ?? 5,
        ignoreErrorPatterns: options.ignoreErrorPatterns ?? COMMON_IGNORE_PATTERNS,
        blockExternalNavigation: options.blockExternalNavigation ?? true,
        actionWeights: options.actionWeights,
        headless: true,
      });

      const fixture: ChaosFixture = {
        crawler,

        async testPage(testPage: Page, url: string): Promise<PageResult> {
          return crawler.testPage(testPage, url);
        },

        async crawl(startUrl: string): Promise<CrawlReport> {
          // Update base URL for crawling
          (crawler as any).options.baseUrl = startUrl;
          (crawler as any).baseOrigin = new URL(startUrl).origin;
          return crawler.start();
        },

        expectNoErrors(result: PageResult | CrawlReport): void {
          if ("pages" in result) {
            // CrawlReport
            const allErrors = result.pages.flatMap((p) => p.errors);
            if (allErrors.length > 0) {
              const errorMessages = allErrors.map((e) => `[${e.type}] ${e.message}`).join("\n");
              throw new Error(`Found ${allErrors.length} errors:\n${errorMessages}`);
            }
          } else {
            // PageResult
            if (result.errors.length > 0) {
              const errorMessages = result.errors.map((e) => `[${e.type}] ${e.message}`).join("\n");
              throw new Error(`Found ${result.errors.length} errors:\n${errorMessages}`);
            }
          }
        },

        expectNoDeadLinks(result: CrawlReport): void {
          const dead = result.summary.discovery?.deadLinks ?? [];
          if (dead.length === 0) return;
          const lines = dead.map(
            (d) => `  ${d.url} (${d.statusCode}) ← ${d.sourceUrl || "(initial)"}`
          );
          throw new Error(`Found ${dead.length} dead links:\n${lines.join("\n")}`);
        },
      };

      await use(fixture);
    },
  };
}

/**
 * Pre-configured test with chaos fixture
 */
export const chaosTest = base.extend<ChaosFixtures>(withChaos());

// -------- Recipe fixture (issue #91) --------

export interface RecipesFixture {
  /** Shared `RecipeStore` instance — same store across the test. */
  store: RecipeStore;
  /**
   * Replay a verified recipe by name. Throws when the recipe doesn't
   * exist or replay fails. `requires` chain is honoured by default.
   */
  runRecipe(name: string, opts?: RunRecipeFixtureOptions): Promise<void>;
  /**
   * Harvest scenarios the current page self-declares on
   * `window.__chaosbringer` (WebMCP-style). Returns the candidate
   * recipes; the caller decides whether to upsert.
   */
  harvestPageScenarios(opts?: { trustPublisher?: boolean }): Promise<ActionRecipe[]>;
  /**
   * Run the Phase-D investigator against a captured failure. Returns
   * the InvestigateResult — the regression recipe (if any) is also
   * upserted into the fixture's store.
   */
  investigate(failure: FailureContext, opts?: InvestigateFixtureOptions): Promise<InvestigateResult>;
}

export interface RunRecipeFixtureOptions {
  /** Template variables for `{{var}}` substitution. */
  vars?: RecipeVars;
  /** Skip `requires` chaining (default: chained). */
  chainRequires?: boolean;
  /** Storage-state snapshot policy. */
  snapshot?: boolean | SnapshotPolicy;
}

export interface InvestigateFixtureOptions {
  /** Max actions to spend reproducing. Default: 20. */
  budget?: number;
  /** Drives the investigator; required if you want a real AI replay. */
  driver?: import("./drivers/types.js").Driver;
  /** Run minimisation (1-minimal delta debugging). */
  minimize?: boolean;
}

export interface RecipesFixtureOptions {
  /** `RecipeStore` options. Defaults to `localDir: "./chaosbringer-recipes"`. */
  store?: RecipeStoreOptions;
  /**
   * Re-use a pre-built store. If set, `store` options are ignored.
   * Useful when you want every test to see the same in-memory cache
   * accumulated by a `beforeAll`.
   */
  storeInstance?: RecipeStore;
}

export interface RecipesFixtures {
  store: RecipeStore;
  runRecipe: RecipesFixture["runRecipe"];
  harvestPageScenarios: RecipesFixture["harvestPageScenarios"];
  investigate: RecipesFixture["investigate"];
}

/**
 * Build the recipes fixture set. Extend an existing Playwright Test
 * with:
 *
 *   const test = base.extend<RecipesFixtures>(withRecipes());
 *   test("buy flow", async ({ runRecipe }) => {
 *     await runRecipe("shop/buy-tshirt", { vars: { email: "..." } });
 *   });
 */
export function withRecipes(defaults: RecipesFixtureOptions = {}) {
  const sharedStore = defaults.storeInstance ?? new RecipeStore({ silent: true, ...(defaults.store ?? {}) });

  return {
    // Playwright Test inspects the parameter declaration to wire
    // up `store: { use }` against the fixture's dependencies. The
    // body doesn't need any of them, but the destructured pattern
    // must be present.
    store: async (
      { page: _page }: { page: Page },
      use: (s: RecipeStore) => Promise<void>,
    ) => {
      void _page;
      await use(sharedStore);
    },

    runRecipe: async (
      { page, store }: { page: Page; store: RecipeStore },
      use: (fn: RecipesFixture["runRecipe"]) => Promise<void>,
    ) => {
      await use(async (name, opts = {}) => {
        const recipe = store.get(name);
        if (!recipe) throw new Error(`runRecipe: "${name}" not found in store`);

        const chain = opts.chainRequires !== false;
        if (chain && recipe.requires.filter((d) => !d.startsWith("__")).length > 0) {
          const result = await runRecipeWithRequires({
            page,
            recipe,
            store,
            vars: opts.vars,
            snapshot: opts.snapshot,
            onProgress: (ev) => {
              if (ev.kind === "complete") {
                if (ev.result.ok) store.recordSuccess(ev.recipe, ev.result.durationMs);
                else store.recordFailure(ev.recipe);
              }
            },
          });
          if (!result.ok) {
            throw new Error(
              `runRecipe(${name}): chain failed at ${result.failedAt}: ${result.results[result.failedAt!]?.failedAt?.reason ?? "unknown"}`,
            );
          }
          return;
        }
        const result = await replayRecipe(page, recipe, { vars: opts.vars });
        if (result.ok) {
          store.recordSuccess(name, result.durationMs);
          return;
        }
        store.recordFailure(name);
        throw new Error(
          `runRecipe(${name}): step ${result.failedAt?.index} failed — ${result.failedAt?.reason ?? "unknown"}`,
        );
      });
    },

    harvestPageScenarios: async (
      { page, store }: { page: Page; store: RecipeStore },
      use: (fn: RecipesFixture["harvestPageScenarios"]) => Promise<void>,
    ) => {
      await use(async (opts = {}) => {
        const harvested = await loadPageScenarios(page, opts);
        // Mirror the auto-upsert convention from the cookbook examples.
        for (const r of harvested) store.upsert(r);
        return harvested;
      });
    },

    investigate: async (
      { store }: { store: RecipeStore },
      use: (fn: RecipesFixture["investigate"]) => Promise<void>,
    ) => {
      await use(async (failure, opts = {}) => {
        if (!opts.driver) {
          throw new Error(
            "investigate fixture: a `driver` is required — typically `aiDriver({ provider: anthropicDriverProvider(...) })`",
          );
        }
        return runInvestigate({
          failure,
          driver: opts.driver,
          store,
          budget: opts.budget,
          minimize: opts.minimize,
        });
      });
    },
  };
}

/**
 * Pre-configured test with both chaos AND recipes fixtures. Use this
 * when you want a single `test` symbol with everything wired.
 */
export const recipesTest = base.extend<RecipesFixtures>(withRecipes());

/**
 * Helper to run chaos test on current page
 */
export async function runChaosTest(
  page: Page,
  options: ChaosTestOptions = {}
): Promise<PageResult> {
  const url = page.url();
  const crawler = new ChaosCrawler({
    baseUrl: url,
    maxPages: 1,
    maxActionsPerPage: options.maxActionsPerPage ?? 5,
    ignoreErrorPatterns: options.ignoreErrorPatterns ?? COMMON_IGNORE_PATTERNS,
    blockExternalNavigation: options.blockExternalNavigation ?? true,
    actionWeights: options.actionWeights,
    headless: true,
  });

  return crawler.testPage(page, url);
}

/**
 * Expect helper for chaos results
 */
export const chaosExpect = {
  toHaveNoErrors(result: PageResult | CrawlReport) {
    if ("pages" in result) {
      const allErrors = result.pages.flatMap((p) => p.errors);
      expect(allErrors, `Expected no errors but found: ${JSON.stringify(allErrors)}`).toHaveLength(0);
    } else {
      expect(
        result.errors,
        `Expected no errors but found: ${JSON.stringify(result.errors)}`
      ).toHaveLength(0);
    }
  },

  toHaveNoExceptions(result: PageResult | CrawlReport) {
    const errors = "pages" in result ? result.pages.flatMap((p) => p.errors) : result.errors;
    const exceptions = errors.filter((e) => e.type === "exception" || e.type === "unhandled-rejection");
    expect(
      exceptions,
      `Expected no exceptions but found: ${JSON.stringify(exceptions)}`
    ).toHaveLength(0);
  },

  toLoadWithin(result: PageResult, maxMs: number) {
    expect(result.loadTime, `Page load time ${result.loadTime}ms exceeded ${maxMs}ms`).toBeLessThanOrEqual(
      maxMs
    );
  },

  toHaveNoDeadLinks(result: CrawlReport) {
    const dead = result.summary.discovery?.deadLinks ?? [];
    if (dead.length === 0) {
      expect(dead).toHaveLength(0);
      return;
    }
    const detail = dead
      .map((d) => `  ${d.url} (${d.statusCode}) ← ${d.sourceUrl || "(initial)"}`)
      .join("\n");
    expect(
      dead,
      `Expected no dead links but found ${dead.length}:\n${detail}`
    ).toHaveLength(0);
  },
};
