import { describe, expect, it } from "vitest";
import {
  hasTemplates,
  recipeVariables,
  substituteCondition,
  substituteStep,
  substituteSteps,
  substituteString,
  UndefinedVariableError,
} from "./templating.js";
import type { RecipeStep } from "./types.js";

describe("substituteString", () => {
  it("replaces a single placeholder", () => {
    expect(substituteString("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  it("replaces multiple occurrences", () => {
    expect(substituteString("{{x}}-{{y}}-{{x}}", { x: "a", y: "b" })).toBe("a-b-a");
  });

  it("supports dotted names + numbers + underscore", () => {
    expect(substituteString("{{user.email}} {{count}} {{is_admin}}", {
      "user.email": "a@b.c",
      count: 3,
      is_admin: true,
    })).toBe("a@b.c 3 true");
  });

  it("ignores leading/trailing whitespace inside {{ }}", () => {
    expect(substituteString("{{ name }}", { name: "x" })).toBe("x");
  });

  it("throws when a referenced variable is missing", () => {
    expect(() => substituteString("{{missing}}", {})).toThrow(/missing/);
    expect(() => substituteString("{{missing}}", {})).toThrow(UndefinedVariableError);
  });

  // `name in vars` found Object.prototype's: `{{constructor}}` typed the
  // source of `function Object()` instead of failing as undefined.
  it("does not take a variable from the prototype", () => {
    expect(() => substituteString("{{constructor}}", {})).toThrow(UndefinedVariableError);
    expect(() => substituteString("{{toString}}", {})).toThrow(UndefinedVariableError);
  });

  it("does not read a substituted value as a template again", () => {
    expect(substituteString("{{name}}", { name: "{{name}}" })).toBe("{{name}}");
  });

  it("passes through strings without placeholders", () => {
    expect(substituteString("plain text", { ignored: "x" })).toBe("plain text");
  });
});

describe("hasTemplates", () => {
  it("detects placeholders", () => {
    expect(hasTemplates("hi {{x}}")).toBe(true);
  });
  it("ignores plain strings", () => {
    expect(hasTemplates("hi")).toBe(false);
  });
  it("ignores malformed placeholders", () => {
    expect(hasTemplates("{ x }")).toBe(false);
    expect(hasTemplates("{{ }}")).toBe(false);
  });
});

describe("substituteStep", () => {
  it("substitutes fill.value", () => {
    const step: RecipeStep = { kind: "fill", selector: "[name=email]", value: "{{email}}" };
    const out = substituteStep(step, { email: "alice@example.com" });
    expect(out).toEqual({ kind: "fill", selector: "[name=email]", value: "alice@example.com" });
  });

  it("substitutes navigate.url", () => {
    const step: RecipeStep = { kind: "navigate", url: "{{base}}/product/{{id}}" };
    const out = substituteStep(step, { base: "https://x.test", id: 42 });
    expect((out as { url: string }).url).toBe("https://x.test/product/42");
  });

  it("substitutes select.value", () => {
    const step: RecipeStep = { kind: "select", selector: "#size", value: "{{size}}" };
    const out = substituteStep(step, { size: "L" });
    expect((out as { value: string }).value).toBe("L");
  });

  it("returns the same reference when no template", () => {
    const step: RecipeStep = { kind: "click", selector: "[data-test=buy]" };
    expect(substituteStep(step, { x: "y" })).toBe(step);
  });

  it("does not substitute selectors / keys", () => {
    const step: RecipeStep = { kind: "press", key: "Enter", selector: "input" };
    expect(substituteStep(step, { key: "ignored" })).toBe(step);
  });

  it("does not touch click-at / wait / waitFor", () => {
    const a: RecipeStep = { kind: "click-at", x: 1, y: 2 };
    const b: RecipeStep = { kind: "wait", ms: 100 };
    const c: RecipeStep = { kind: "waitFor", selector: ".x" };
    expect(substituteStep(a, {})).toBe(a);
    expect(substituteStep(b, {})).toBe(b);
    expect(substituteStep(c, {})).toBe(c);
  });
});

describe("substituteSteps", () => {
  it("returns same array ref when no step has templates (no-op fast path)", () => {
    const steps: RecipeStep[] = [
      { kind: "click", selector: "a" },
      { kind: "wait", ms: 10 },
    ];
    expect(substituteSteps(steps, { x: "y" })).toBe(steps);
  });

  it("returns a fresh array when at least one step changed", () => {
    const steps: RecipeStep[] = [
      { kind: "click", selector: "a" },
      { kind: "fill", selector: "[name=email]", value: "{{email}}" },
    ];
    const out = substituteSteps(steps, { email: "a@b" });
    expect(out).not.toBe(steps);
    expect((out[1] as { value: string }).value).toBe("a@b");
    // First (untemplated) step is reused by reference inside the new array.
    expect(out[0]).toBe(steps[0]);
  });
});

describe("substituteCondition", () => {
  it("escapes a value in a urlPattern, and inserts it into a selector as written", () => {
    expect(substituteCondition({ urlPattern: "^/orders/{{id}}$", hasSelector: "text=Order {{id}}" }, { id: "1.0(x)" })).toEqual({
      urlPattern: "^/orders/1\\.0\\(x\\)$",
      hasSelector: "text=Order 1.0(x)",
    });
  });

  it("returns the condition itself when it has no placeholder", () => {
    const c = { urlPattern: "^/done", hidesSelector: ".spinner" };
    expect(substituteCondition(c, {})).toBe(c);
  });
});

describe("recipeVariables", () => {
  it("names each placeholder of the steps and conditions once, in order of use", () => {
    expect(
      recipeVariables({
        preconditions: [{ urlPattern: "^{{base}}/" }],
        steps: [
          { kind: "navigate", url: "{{base}}/login" },
          { kind: "fill", selector: "#u", value: "{{ user }}" },
          { kind: "fill", selector: "#p", value: "{{password}}" },
          { kind: "press", key: "{{not-a-field}}" },
          { kind: "select", selector: "#plan", value: "{{plan}}" },
        ],
        postconditions: [{ hasSelector: "text=Hi {{user}}" }],
      }),
    ).toEqual(["base", "user", "password", "plan"]);
  });
});
