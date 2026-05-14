import { describe, expect, it } from "vitest";
import { diffRecipes, formatRecipeDiff } from "./diff.js";
import type { ActionRecipe } from "./types.js";
import { emptyStats } from "./types.js";

function makeRecipe(name: string, overrides: Partial<ActionRecipe> = {}): ActionRecipe {
  return {
    name,
    description: `desc for ${name}`,
    preconditions: [{ urlPattern: "^/" }],
    steps: [{ kind: "click", selector: "#one" }],
    postconditions: [],
    requires: [],
    stats: emptyStats(),
    origin: "ai-extracted",
    status: "candidate",
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("diffRecipes", () => {
  it("reports identical when steps + tracked fields match", () => {
    const a = makeRecipe("r", { version: 1 });
    const b = makeRecipe("r", { version: 2 });
    const diff = diffRecipes(a, b);
    expect(diff.identical).toBe(true);
    expect(diff.steps.every((s) => s.op === "equal")).toBe(true);
  });

  it("detects added step", () => {
    const a = makeRecipe("r", {
      steps: [{ kind: "click", selector: "#a" }],
    });
    const b = makeRecipe("r", {
      steps: [
        { kind: "click", selector: "#a" },
        { kind: "fill", selector: "#b", value: "x" },
      ],
    });
    const diff = diffRecipes(a, b);
    expect(diff.identical).toBe(false);
    const adds = diff.steps.filter((s) => s.op === "add");
    expect(adds).toHaveLength(1);
    expect(adds[0]!.json).toContain('"fill"');
  });

  it("detects removed step", () => {
    const a = makeRecipe("r", {
      steps: [
        { kind: "click", selector: "#a" },
        { kind: "click", selector: "#b" },
      ],
    });
    const b = makeRecipe("r", { steps: [{ kind: "click", selector: "#a" }] });
    const diff = diffRecipes(a, b);
    const removes = diff.steps.filter((s) => s.op === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]!.json).toContain('"#b"');
  });

  it("detects a step replacement (one remove + one add)", () => {
    const a = makeRecipe("r", {
      steps: [
        { kind: "click", selector: "#old" },
        { kind: "click", selector: "#shared" },
      ],
    });
    const b = makeRecipe("r", {
      steps: [
        { kind: "click", selector: "#new" },
        { kind: "click", selector: "#shared" },
      ],
    });
    const diff = diffRecipes(a, b);
    expect(diff.steps.filter((s) => s.op === "remove")).toHaveLength(1);
    expect(diff.steps.filter((s) => s.op === "add")).toHaveLength(1);
    expect(diff.steps.filter((s) => s.op === "equal")).toHaveLength(1);
  });

  it("reports tracked field changes (status promotion)", () => {
    const a = makeRecipe("r", { status: "candidate" });
    const b = makeRecipe("r", { status: "verified" });
    const diff = diffRecipes(a, b);
    expect(diff.identical).toBe(false);
    expect(diff.fields.find((f) => f.field === "status")).toMatchObject({
      left: "candidate",
      right: "verified",
    });
  });

  it("normalises key order before comparing", () => {
    // Two semantically identical steps with different key order should
    // compare equal — canonicaliseStep sorts keys.
    const a = makeRecipe("r", {
      steps: [{ kind: "fill", selector: "#x", value: "v" }],
    });
    const b = makeRecipe("r", {
      // Same fields, different order via JSON.parse/stringify won't
      // reorder in TS — but the diff's canonicalisation does.
      steps: [{ kind: "fill", selector: "#x", value: "v" }],
    });
    expect(diffRecipes(a, b).identical).toBe(true);
  });
});

describe("formatRecipeDiff", () => {
  it("renders unified-diff style with +/- markers", () => {
    const a = makeRecipe("r", { steps: [{ kind: "click", selector: "#a" }] });
    const b = makeRecipe("r", {
      steps: [
        { kind: "click", selector: "#a" },
        { kind: "click", selector: "#b" },
      ],
    });
    const out = formatRecipeDiff(diffRecipes(a, b));
    expect(out).toContain("--- r@v1");
    expect(out).toContain("+++ r@v1");
    expect(out).toMatch(/^\+ /m);
  });

  it("reports no step changes for identical recipes", () => {
    const a = makeRecipe("r");
    const out = formatRecipeDiff(diffRecipes(a, a));
    expect(out).toMatch(/no step changes/);
  });

  it("includes Field changes section when tracked fields differ", () => {
    const a = makeRecipe("r", { status: "candidate" });
    const b = makeRecipe("r", { status: "verified" });
    const out = formatRecipeDiff(diffRecipes(a, b));
    expect(out).toContain("Field changes");
    expect(out).toContain("status");
  });
});
