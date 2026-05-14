import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function makeRecipe(
  name: string,
  urlPattern: string | undefined = undefined,
): ActionRecipe {
  return {
    name,
    description: "",
    preconditions: urlPattern ? [{ urlPattern }] : [],
    steps: [{ kind: "click", selector: "a" }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "hand-written",
    status: "verified",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-d-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("RecipeStore.byDomain", () => {
  it("returns recipes whose first urlPattern contains the host (regex-escaped)", () => {
    const s = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    s.upsert(makeRecipe("a", "github\\.com\\/.*"));
    s.upsert(makeRecipe("b", "linkedin\\.com\\/.*"));
    s.upsert(makeRecipe("c", "github\\.com\\/issues"));
    const got = s.byDomain("github.com").map((r) => r.name).sort();
    expect(got).toEqual(["a", "c"]);
  });

  it("recipes without a urlPattern are returned for every domain", () => {
    const s = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    s.upsert(makeRecipe("scoped", "example\\.com"));
    s.upsert(makeRecipe("global", undefined));
    expect(s.byDomain("example.com").map((r) => r.name).sort()).toEqual(["global", "scoped"]);
    expect(s.byDomain("other.com").map((r) => r.name)).toEqual(["global"]);
  });

  it("returns an empty list when nothing matches", () => {
    const s = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    s.upsert(makeRecipe("a", "example\\.com"));
    expect(s.byDomain("absent.org")).toEqual([]);
  });
});

describe("RecipeStore.domains", () => {
  it("extracts distinct hostnames from urlPatterns", () => {
    const s = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    s.upsert(makeRecipe("a", "github\\.com\\/.*"));
    s.upsert(makeRecipe("b", "github\\.com\\/issues"));
    s.upsert(makeRecipe("c", "linkedin\\.com\\/jobs"));
    s.upsert(makeRecipe("d", undefined));
    expect(s.domains()).toEqual(["github.com", "linkedin.com"]);
  });
});
