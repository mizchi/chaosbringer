/**
 * E2E for `scenarioLoadFromStore` — runs a real Chromium-backed
 * load test against the fixture site using two verified recipes
 * pulled from a `RecipeStore`. Also exercises templating: the
 * navigate URL contains `{{base}}` which gets resolved per-iteration
 * to the fixture's actual address.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RecipeStore,
  scenarioLoadFromStore,
  type ActionRecipe,
} from "../../src/recipes/index.js";
import { emptyStats } from "../../src/recipes/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let storeDir: string;

beforeAll(async () => {
  server = await startFixtureServer(0);
  storeDir = mkdtempSync(join(tmpdir(), "lfs-e2e-"));
}, 30000);

afterAll(async () => {
  await server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

function mkRecipe(name: string, steps: ActionRecipe["steps"]): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps,
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("scenarioLoadFromStore against fixture", () => {
  it("drives 2 workers through verified recipes with templated baseUrl", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    // Two distinct verified recipes — both use {{base}} templating so
    // the same recipe works against any host.
    store.upsert(
      mkRecipe("nav/about", [
        { kind: "navigate", url: "{{base}}/", expectAfter: { hasSelector: "h1" } },
        {
          kind: "click",
          selector: 'a[href="/about"]',
          expectAfter: { urlContains: "/about", timeoutMs: 3000 },
        },
      ]),
    );
    store.upsert(
      mkRecipe("nav/form", [
        {
          kind: "navigate",
          url: "{{base}}/form",
          expectAfter: { hasSelector: "h1" },
        },
      ]),
    );

    const result = await scenarioLoadFromStore({
      baseUrl: server.url,
      store,
      workers: 2,
      duration: "3s",
      timelineBucketMs: 1000,
      vars: { base: server.url },
    });
    const { report } = result;

    expect(report.config.workers).toBe(2);
    expect(report.scenarios.length).toBe(1);
    const mix = report.scenarios[0]!;
    expect(mix.name).toBe("recipe-mix");
    expect(mix.iterations).toBeGreaterThan(0);

    // Issue #92: per-recipe firing summary is surfaced on the result.
    expect(result.recipes).toBeDefined();
    expect(Array.isArray(result.recipes)).toBe(true);
    expect(result.recipes.length).toBeGreaterThan(0);
    const totalFired = result.recipes.reduce((a, r) => a + r.fired, 0);
    // Total firings should match the number of completed iterations.
    expect(totalFired).toBe(mix.iterations);
    // Both recipes are uniformly selectable; over a 3s run with two
    // workers we should see *some* iterations succeed. (Exact
    // success count is timing-dependent.)
    expect(mix.iterations).toBeGreaterThanOrEqual(2);

    // Stats updated through the store — verified count must climb.
    const reloaded = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    const a = reloaded.get("nav/about");
    const b = reloaded.get("nav/form");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const totalRuns =
      a!.stats.successCount + a!.stats.failCount +
      b!.stats.successCount + b!.stats.failCount;
    expect(totalRuns).toBeGreaterThan(0);
  }, 60000);

  it("vars as a function are evaluated per-iteration", async () => {
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    // The recipe re-navigates each iteration to a different path —
    // proves the function form of `vars` is evaluated each time.
    store.upsert(
      mkRecipe("nav/per-iter", [
        {
          kind: "navigate",
          url: "{{base}}/{{path}}",
          expectAfter: { hasSelector: "h1" },
        },
      ]),
    );

    const seenPaths = new Set<string>();
    const { report } = await scenarioLoadFromStore({
      baseUrl: server.url,
      store,
      workers: 1,
      duration: "5s",
      // Disable think-time so a short run gets enough iterations to
      // observe both branches of the path alternation below.
      thinkTime: { distribution: "none" },
      vars: (ctx) => {
        const path = ctx.iteration % 2 === 0 ? "about" : "form";
        seenPaths.add(path);
        return { base: server.url, path };
      },
    });

    expect(report.scenarios[0]!.iterations).toBeGreaterThan(0);
    // Across multiple iterations we should observe both branches.
    expect(seenPaths.size).toBe(2);
  }, 60000);
});
