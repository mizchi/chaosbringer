import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDependencies } from "./composition.js";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function recipe(name: string, requires: string[] = []): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: [],
    steps: [{ kind: "click", selector: "a" }],
    postconditions: [],
    requires,
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-c-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("resolveDependencies", () => {
  it("returns the recipe alone when it has no requires", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const r = recipe("solo");
    store.upsert(r);
    expect(resolveDependencies(r, store).map((x) => x.name)).toEqual(["solo"]);
  });

  it("orders deps before dependent (topological)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("auth/login"));
    store.upsert(recipe("nav/dashboard", ["auth/login"]));
    const target = recipe("shop/checkout", ["nav/dashboard"]);
    store.upsert(target);
    const order = resolveDependencies(target, store).map((r) => r.name);
    expect(order).toEqual(["auth/login", "nav/dashboard", "shop/checkout"]);
  });

  it("dedupes diamond dependencies (same dep reached via two paths)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("base"));
    store.upsert(recipe("left", ["base"]));
    store.upsert(recipe("right", ["base"]));
    const top = recipe("top", ["left", "right"]);
    store.upsert(top);
    const order = resolveDependencies(top, store).map((r) => r.name);
    expect(order).toEqual(["base", "left", "right", "top"]);
    expect(order.length).toBe(4); // not 5
  });

  it("ignores '__'-prefixed sentinel requires (used for repair provenance)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const r = recipe("repaired", ["__repaired-from-v1"]);
    store.upsert(r);
    expect(resolveDependencies(r, store).map((x) => x.name)).toEqual(["repaired"]);
  });

  it("throws on a cycle", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("a", ["b"]));
    store.upsert(recipe("b", ["a"]));
    const a = store.get("a")!;
    expect(() => resolveDependencies(a, store)).toThrow(/cycle/);
  });

  it("throws on a self-loop", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const r = recipe("loop", ["loop"]);
    store.upsert(r);
    expect(() => resolveDependencies(r, store)).toThrow(/cannot require itself/);
  });

  it("throws on unresolved name", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const r = recipe("dependent", ["does-not-exist"]);
    store.upsert(r);
    expect(() => resolveDependencies(r, store)).toThrow(/not found/);
  });

  it("finds the target recipe even if it isn't in the store yet", () => {
    // Useful for "promote-and-check" workflows where the dependent
    // recipe hasn't been upserted but is being validated first.
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(recipe("auth/login"));
    const target = recipe("flow", ["auth/login"]);
    // intentionally NOT upserted
    expect(resolveDependencies(target, store).map((r) => r.name)).toEqual(["auth/login", "flow"]);
  });
});
