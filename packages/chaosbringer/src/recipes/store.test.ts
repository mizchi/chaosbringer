import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeStore, recipeFilename } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function makeRecipe(name: string, overrides: Partial<ActionRecipe> = {}): ActionRecipe {
  return {
    name,
    description: `desc for ${name}`,
    preconditions: [{ urlPattern: "^/" }],
    steps: [{ kind: "click", selector: "[data-test=go]" }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "ai-extracted",
    status: "candidate",
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("recipeFilename", () => {
  it("preserves alphanumerics, replaces / with __, and collapses unsafe chars", () => {
    expect(recipeFilename("shop/checkout")).toBe("shop__checkout.json");
    expect(recipeFilename("a.b_c-d")).toBe("a.b_c-d.json");
    expect(recipeFilename("dangerous?path")).toBe("dangerous_path.json");
  });
});

describe("RecipeStore basics", () => {
  it("upsert + get returns a deep clone (caller mutations don't leak)", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const r = makeRecipe("a");
    store.upsert(r);
    const fetched = store.get("a")!;
    fetched.steps.push({ kind: "wait", ms: 100 });
    expect(store.get("a")!.steps.length).toBe(1);
  });

  it("persists across instances", () => {
    const a = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    a.upsert(makeRecipe("a"));
    const b = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(b.get("a")).not.toBeNull();
    expect(b.get("a")!.name).toBe("a");
  });

  it("local overrides global by name", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "rs-g-"));
    try {
      const a = new RecipeStore({ localDir: false, globalDir, silent: true });
      a.upsert(makeRecipe("x", { description: "from global" }));
      const b = new RecipeStore({ localDir: dir, globalDir, silent: true });
      b.upsert(makeRecipe("x", { description: "from local" }));
      const c = new RecipeStore({ localDir: dir, globalDir, silent: true });
      expect(c.get("x")!.description).toBe("from local");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  it("delete removes the file", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(makeRecipe("a"));
    expect(existsSync(join(dir, "a.json"))).toBe(true);
    store.delete("a");
    expect(existsSync(join(dir, "a.json"))).toBe(false);
    expect(store.get("a")).toBeNull();
  });

  it("skips malformed files instead of throwing", () => {
    // hand-write a broken JSON
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(join(dir, "broken.json"), "{ not json");
    fs.writeFileSync(join(dir, "valid.json"), JSON.stringify(makeRecipe("valid")));
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    expect(store.list().map((r) => r.name)).toEqual(["valid"]);
  });
});

describe("RecipeStore stats + promotion", () => {
  it("recordSuccess increments count, updates rolling mean", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(makeRecipe("a"));
    store.recordSuccess("a", 100);
    store.recordSuccess("a", 200);
    store.recordSuccess("a", 300);
    const s = store.get("a")!.stats;
    expect(s.successCount).toBe(3);
    expect(s.avgDurationMs).toBeCloseTo(200);
    expect(s.maxDurationMs).toBe(300);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it("promotes to verified after minRuns >= 5 with >= 0.8 success rate", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true, minRuns: 5 });
    store.upsert(makeRecipe("a"));
    for (let i = 0; i < 5; i++) store.recordSuccess("a", 100);
    expect(store.get("a")!.status).toBe("verified");
  });

  it("stays candidate when below threshold", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true, minRuns: 5 });
    store.upsert(makeRecipe("a"));
    store.recordSuccess("a", 100);
    store.recordFailure("a");
    store.recordFailure("a");
    store.recordFailure("a");
    store.recordFailure("a");
    expect(store.get("a")!.status).toBe("candidate");
  });

  it("setStatus is a direct override", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(makeRecipe("a"));
    store.setStatus("a", "verified");
    expect(store.get("a")!.status).toBe("verified");
  });

  it("verified() returns only verified recipes", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(makeRecipe("a"));
    store.upsert(makeRecipe("b"));
    store.setStatus("b", "verified");
    expect(store.verified().map((r) => r.name)).toEqual(["b"]);
  });
});

describe("RecipeStore atomic writes", () => {
  it("does not leave .tmp files behind after upsert", () => {
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    store.upsert(makeRecipe("a"));
    const entries = readdirSync(dir);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(entries).toContain("a.json");
  });
});
