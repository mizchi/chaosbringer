/**
 * Tests for recipe version history + rollback (issue #90).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function recipe(name: string, version: number, overrides: Partial<ActionRecipe> = {}): ActionRecipe {
  return {
    name,
    description: `v${version}`,
    preconditions: [],
    steps: [{ kind: "click", selector: `[data-test=v${version}]` }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-h-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("RecipeStore history", () => {
  it("returns [] when no history exists", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    expect(store.history("a")).toEqual([]);
  });

  it("archives the prior version when upserting a new one", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1, { description: "first" }));
    store.upsert(recipe("a", 2, { description: "second" }));
    const history = store.history("a");
    expect(history.length).toBe(1);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.description).toBe("first");
    expect(store.get("a")!.version).toBe(2);
    expect(store.get("a")!.description).toBe("second");
  });

  it("does NOT archive when version is unchanged (stat updates are not new versions)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.recordSuccess("a", 100);
    expect(store.history("a")).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.includes(".v")).length).toBe(0);
  });

  it("orders history newest first", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    store.upsert(recipe("a", 3));
    expect(store.history("a").map((r) => r.version)).toEqual([2, 1]);
  });

  it("ignores `.vN.json` files when loading current recipes (not picked up as duplicates)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    const reloaded = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(reloaded.list().map((r) => r.name)).toEqual(["a"]);
    expect(reloaded.get("a")!.version).toBe(2);
  });
});

describe("RecipeStore rollback", () => {
  it("swaps current with the named historical version", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1, { description: "first" }));
    store.upsert(recipe("a", 2, { description: "second-bad" }));
    const rolled = store.rollback("a", { toVersion: 1 });
    expect(rolled).not.toBeNull();
    expect(rolled!.description).toBe("first");
    // Version bumped past the highest seen.
    expect(rolled!.version).toBe(3);
    expect(store.get("a")!.description).toBe("first");
  });

  it("preserves accumulated stats across the rollback", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    store.recordSuccess("a", 100);
    store.recordSuccess("a", 200);
    const beforeStats = store.get("a")!.stats;
    store.rollback("a", { toVersion: 1 });
    const afterStats = store.get("a")!.stats;
    expect(afterStats.successCount).toBe(beforeStats.successCount);
  });

  it("archives the pre-rollback current as part of the swap", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    store.rollback("a", { toVersion: 1 });
    // The previous current (v2) should be in history; the consumed
    // historical (v1) is now the current.
    const versions = store.history("a").map((r) => r.version).sort();
    expect(versions).toContain(2);
    expect(versions).not.toContain(1);
  });

  it("tags the rolled-back recipe via `requires: __rolled-back-from-vN` (provenance)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    const rolled = store.rollback("a", { toVersion: 1 });
    expect(rolled!.requires).toContain("__rolled-back-from-v2");
  });

  it("returns null when the target version doesn't exist", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    expect(store.rollback("a", { toVersion: 99 })).toBeNull();
  });

  it("returns null when the recipe itself doesn't exist", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(store.rollback("nope", { toVersion: 1 })).toBeNull();
  });
});

describe("RecipeStore pruneHistory", () => {
  it("keeps the N newest versions, drops the rest", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    store.upsert(recipe("a", 3));
    store.upsert(recipe("a", 4));
    expect(store.history("a").length).toBe(3); // v1, v2, v3
    const deleted = store.pruneHistory("a", { keepLast: 1 });
    expect(deleted).toBe(2);
    expect(store.history("a").map((r) => r.version)).toEqual([3]);
  });

  it("is a no-op when there's less history than keepLast", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    store.upsert(recipe("a", 2));
    expect(store.pruneHistory("a", { keepLast: 10 })).toBe(0);
  });
});

describe("RecipeStore.writeDir", () => {
  it("returns the local dir when configured", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(store.writeDir).toBe(dir);
  });
  it("returns null when both tiers are disabled", () => {
    const store = new RecipeStore({ localDir: false, globalDir: false, silent: true });
    expect(store.writeDir).toBeNull();
  });
});

describe("recipe + snapshot sidecar coexistence", () => {
  it("loader ignores .state.json files (snapshot sidecars)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", 1));
    // Hand-write a sibling snapshot file — must not show up as a recipe.
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(join(dir, "a.state.json"), JSON.stringify({ recipeName: "a" }));
    const reloaded = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(reloaded.list().map((r) => r.name)).toEqual(["a"]);
    expect(existsSync(join(dir, "a.state.json"))).toBe(true);
  });
});
