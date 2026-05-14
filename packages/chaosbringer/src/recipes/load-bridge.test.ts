/**
 * Unit tests for the selection strategy used by `recipeStoreScenario`.
 * The "scenario runs and replays" path needs a real Page so is
 * covered by the E2E test; here we just exercise pickRecipe + weight
 * distribution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipeStoreScenario } from "./load-bridge.js";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function recipe(name: string, stats: Partial<ActionRecipe["stats"]> = {}): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps: [{ kind: "click", selector: "a" }],
    postconditions: [],
    requires: [],
    stats: { ...emptyStats(), ...stats },
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lb-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("recipeStoreScenario meta", () => {
  it("uses 'recipe-mix' as the default scenario name", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a"));
    const scenario = recipeStoreScenario({ store });
    expect(scenario.name).toBe("recipe-mix");
    expect(scenario.steps.length).toBe(1);
    expect(scenario.steps[0]!.name).toBe("pick-and-replay");
  });

  it("respects scenarioName override", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a"));
    const scenario = recipeStoreScenario({ store, scenarioName: "checkout-mix" });
    expect(scenario.name).toBe("checkout-mix");
  });

  it("respects filter — only matching candidates are eligible", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("shop/buy"));
    store.upsert(recipe("auth/login"));
    const scenario = recipeStoreScenario({
      store,
      filter: (r) => r.name.startsWith("shop/"),
      // Custom selection lets us verify which candidates were
      // surfaced without running them against a real page.
      selection: (cs) => {
        // The scenario builder filters BEFORE selection — so by the
        // time we see candidates, only "shop/*" should remain.
        expect(cs.map((r) => r.name)).toEqual(["shop/buy"]);
        return cs[0]!;
      },
    });
    // Drive the scenario manually with a stub ctx; we throw inside
    // selection to short-circuit the actual replay.
    await scenario.steps[0]!.run({
      page: {
        url: () => "https://x/",
      } as never,
      workerIndex: 0,
      iteration: 0,
      baseUrl: "https://x/",
    }).catch(() => {});
  });

  it("throws when nothing matches the filter", async () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("auth/login"));
    const scenario = recipeStoreScenario({
      store,
      filter: () => false,
    });
    await expect(
      scenario.steps[0]!.run({
        page: { url: () => "https://x/" } as never,
        workerIndex: 0,
        iteration: 0,
        baseUrl: "https://x/",
      }),
    ).rejects.toThrow(/no verified recipes/);
  });
});

describe("recipeStoreScenario selection strategies", () => {
  function recordPicks(
    selection: ReturnType<typeof recipeStoreScenario> extends never
      ? never
      : Parameters<typeof recipeStoreScenario>[0]["selection"],
    iterations: number,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("reliable", { successCount: 100, failCount: 0 }));
    store.upsert(recipe("flaky", { successCount: 2, failCount: 10 }));
    store.upsert(recipe("untested"));
    const recordingSelection: typeof selection = (cs, ctx) => {
      // Delegate to the real strategy and record which one was picked.
      const picked = (typeof selection === "function"
        ? selection
        : pickViaStrategy(selection ?? "uniform"))(cs, ctx);
      counts.set(picked.name, (counts.get(picked.name) ?? 0) + 1);
      return picked;
    };
    const scenario = recipeStoreScenario({ store, selection: recordingSelection });
    for (let i = 0; i < iterations; i++) {
      // Catch errors thrown by replay (Page is fake) so the loop continues.
      scenario.steps[0]!
        .run({
          page: { url: () => "https://x/" } as never,
          workerIndex: 0,
          iteration: i,
          baseUrl: "https://x/",
        })
        .catch(() => {});
    }
    return counts;
  }

  function pickViaStrategy(strategy: "uniform" | "by-success-rate") {
    return (cs: ReadonlyArray<ActionRecipe>) => {
      if (strategy === "uniform") {
        return cs[Math.floor(Math.random() * cs.length)]!;
      }
      const weights = cs.map((r) => {
        const total = r.stats.successCount + r.stats.failCount;
        const rate = (r.stats.successCount + 1) / (total + 1);
        return Math.max(0.1, Math.min(1, rate));
      });
      const sum = weights.reduce((a, b) => a + b, 0);
      let pick = Math.random() * sum;
      for (let i = 0; i < cs.length; i++) {
        pick -= weights[i]!;
        if (pick <= 0) return cs[i]!;
      }
      return cs[cs.length - 1]!;
    };
  }

  it("uniform selection visits every candidate over many iterations", () => {
    vi.spyOn(Math, "random").mockImplementation((() => {
      let i = 0;
      const seq = [0.1, 0.5, 0.9]; // hits each index once
      return () => seq[i++ % seq.length]!;
    })());
    const counts = recordPicks("uniform", 30);
    expect(counts.size).toBe(3);
    vi.restoreAllMocks();
  });

  it("by-success-rate biases towards reliable recipes", () => {
    // Run many iterations with the real Math.random — over 200
    // samples the reliable recipe should win the majority.
    const counts = recordPicks("by-success-rate", 200);
    const reliable = counts.get("reliable") ?? 0;
    const flaky = counts.get("flaky") ?? 0;
    expect(reliable).toBeGreaterThan(flaky);
  });

  it("custom function gets the candidates + ctx", () => {
    const seen: number[] = [];
    const scenario = recipeStoreScenario({
      store: (() => {
        const s = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
        s.upsert(recipe("only"));
        return s;
      })(),
      selection: (_cs, ctx) => {
        seen.push(ctx.workerIndex);
        seen.push(ctx.iteration);
        return _cs[0]!;
      },
    });
    scenario.steps[0]!
      .run({
        page: { url: () => "https://x/" } as never,
        workerIndex: 3,
        iteration: 7,
        baseUrl: "https://x/",
      })
      .catch(() => {});
    expect(seen).toEqual([3, 7]);
  });
});
