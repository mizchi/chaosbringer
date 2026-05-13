import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import { boundaryValueProvider, defaultValueProvider, fromList } from "./field-values.js";

describe("defaultValueProvider", () => {
  it("returns sensible values per input type", () => {
    const p = defaultValueProvider();
    const rng = createRng(1);
    expect(p.valueFor({ selector: "#a", inputType: "email" }, rng)).toMatch(/@/);
    expect(p.valueFor({ selector: "#a", inputType: "url" }, rng)).toMatch(/^https?:/);
    expect(p.valueFor({ selector: "#a", inputType: "number" }, rng)).toMatch(/^-?\d+$/);
    expect(p.valueFor({ selector: "#a", inputType: "checkbox" }, rng)).toBe("checked");
  });

  it("picks a select option when provided", () => {
    const p = defaultValueProvider();
    const v = p.valueFor(
      { selector: "#s", inputType: "select", options: ["x", "y", "z"] },
      createRng(1),
    );
    expect(["x", "y", "z"]).toContain(v);
  });

  it("returns null for select without options", () => {
    const p = defaultValueProvider();
    expect(
      p.valueFor({ selector: "#s", inputType: "select" }, createRng(1)),
    ).toBeNull();
  });
});

describe("boundaryValueProvider", () => {
  it("emits diverse boundary strings", () => {
    const p = boundaryValueProvider();
    const set = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const v = p.valueFor({ selector: "#a", inputType: "text" }, createRng(i + 1));
      if (v !== null) set.add(v);
    }
    expect(set.size).toBeGreaterThan(2);
    expect(set.has("")).toBe(true);
  });

  it("respects maxLength when provided", () => {
    const p = boundaryValueProvider();
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const v = p.valueFor(
        { selector: "#a", inputType: "text", maxLength: 4 },
        createRng(i + 1),
      );
      if (v !== null) seen.add(v.length);
    }
    expect(seen.has(4)).toBe(true);
    expect(seen.has(5)).toBe(true);
  });

  it("includes javascript: payload for url type", () => {
    const p = boundaryValueProvider();
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const v = p.valueFor({ selector: "#a", inputType: "url" }, createRng(i + 1));
      if (v !== null) seen.add(v);
    }
    expect(Array.from(seen).some((v) => v.startsWith("javascript:"))).toBe(true);
  });
});

describe("fromList", () => {
  it("returns values from the list", () => {
    const p = fromList("test", ["a", "b", "c"]);
    const v = p.valueFor({ selector: "#a", inputType: "text" }, createRng(1));
    expect(["a", "b", "c"]).toContain(v);
  });

  it("skips text payload for checkbox", () => {
    const p = fromList("xss", ["<script>"]);
    expect(p.valueFor({ selector: "#a", inputType: "checkbox" }, createRng(1))).toBe("checked");
  });

  it("throws on empty list", () => {
    expect(() => fromList("x", [])).toThrow();
  });
});
