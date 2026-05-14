import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintRecipe, lintStore, summarise } from "./lint.js";
import { RecipeStore, recipeFilename } from "./store.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function makeRecipe(name: string, overrides: Partial<ActionRecipe> = {}): ActionRecipe {
  return {
    name,
    description: `desc for ${name}`,
    preconditions: [{ urlPattern: "^/" }],
    steps: [{ kind: "click", selector: "[data-test=go]", expectAfter: { urlContains: "/" } }],
    postconditions: [{ urlPattern: "/done" }],
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

describe("lintRecipe", () => {
  it("flags empty steps as an error", () => {
    const issues = lintRecipe(makeRecipe("r", { steps: [] }));
    expect(issues.some((i) => i.rule === "empty-steps" && i.severity === "error")).toBe(true);
  });

  it("flags missing expectAfter on click/fill as a warning", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "click", selector: "#a" },
          { kind: "fill", selector: "#b", value: "x" },
        ],
      }),
    );
    const missing = issues.filter((i) => i.rule === "missing-expect-after");
    expect(missing).toHaveLength(2);
    expect(missing[0]!.severity).toBe("warn");
  });

  it("flags click-at without viewportHint as an error", () => {
    const issues = lintRecipe(
      makeRecipe("r", { steps: [{ kind: "click-at", x: 10, y: 20 }] }),
    );
    expect(issues.some((i) => i.rule === "click-at-without-viewport-hint" && i.severity === "error")).toBe(true);
  });

  it("accepts click-at WITH viewportHint", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "click-at", x: 10, y: 20, viewportHint: { width: 1280, height: 720 } },
        ],
      }),
    );
    expect(issues.find((i) => i.rule === "click-at-without-viewport-hint")).toBeUndefined();
  });

  it("flags empty preconditions as a warning", () => {
    const issues = lintRecipe(makeRecipe("r", { preconditions: [] }));
    expect(issues.some((i) => i.rule === "empty-preconditions" && i.severity === "warn")).toBe(true);
  });

  it("flags verified recipe without postconditions as error", () => {
    const issues = lintRecipe(
      makeRecipe("r", { status: "verified", postconditions: [] }),
    );
    expect(issues.some((i) => i.rule === "verified-without-postconditions" && i.severity === "error")).toBe(true);
  });

  it("flags long raw waits", () => {
    const issues = lintRecipe(
      makeRecipe("r", { steps: [{ kind: "wait", ms: 5000 }] }),
    );
    expect(issues.some((i) => i.rule === "long-raw-wait")).toBe(true);
  });

  it("flags adjacent duplicate waits as info", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "wait", ms: 100 },
          { kind: "wait", ms: 100 },
        ],
      }),
    );
    expect(issues.some((i) => i.rule === "adjacent-duplicate-wait" && i.severity === "info")).toBe(true);
  });

  it("flags hardcoded credentials on password-looking selectors", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "fill", selector: "input[name=password]", value: "hunter2" },
        ],
      }),
    );
    expect(issues.some((i) => i.rule === "hardcoded-credentials")).toBe(true);
  });

  it("does NOT flag credential fields when templated", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "fill", selector: "input[name=password]", value: "{{password}}" },
        ],
      }),
    );
    expect(issues.find((i) => i.rule === "hardcoded-credentials")).toBeUndefined();
  });

  it("does NOT flag 'test'-prefixed dummy values", () => {
    const issues = lintRecipe(
      makeRecipe("r", {
        steps: [
          { kind: "fill", selector: "input[name=password]", value: "test1234" },
        ],
      }),
    );
    expect(issues.find((i) => i.rule === "hardcoded-credentials")).toBeUndefined();
  });
});

describe("lintStore cross-recipe checks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRecipe(name: string, overrides: Partial<ActionRecipe> = {}): void {
    mkdirSync(dir, { recursive: true });
    const recipe = makeRecipe(name, overrides);
    writeFileSync(join(dir, recipeFilename(name)), JSON.stringify(recipe, null, 2));
  }

  it("flags requires pointing at unknown recipes", () => {
    writeRecipe("a", { requires: ["does-not-exist"] });
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const report = lintStore(store);
    expect(report.issues.some((i) => i.rule === "missing-required-recipe")).toBe(true);
    expect(report.errorCount).toBeGreaterThan(0);
  });

  it("does NOT flag __-prefixed sentinel requires", () => {
    writeRecipe("a", { requires: ["__repaired-from-v3"] });
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const issues = lintStore(store).issues.filter((i) => i.rule === "missing-required-recipe");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag missing-required when the dep exists", () => {
    writeRecipe("a");
    writeRecipe("b", { requires: ["a"] });
    const store = new RecipeStore({ localDir: dir, globalDir: false, silent: true });
    const issues = lintStore(store).issues.filter((i) => i.rule === "missing-required-recipe");
    expect(issues).toHaveLength(0);
  });
});

describe("summarise", () => {
  it("counts by severity", () => {
    const r = summarise([
      { recipe: "x", severity: "error", rule: "empty-steps", message: "" },
      { recipe: "x", severity: "warn", rule: "missing-expect-after", message: "" },
      { recipe: "x", severity: "warn", rule: "missing-expect-after", message: "" },
      { recipe: "x", severity: "info", rule: "adjacent-duplicate-wait", message: "" },
    ]);
    expect(r.errorCount).toBe(1);
    expect(r.warnCount).toBe(2);
    expect(r.infoCount).toBe(1);
  });
});
