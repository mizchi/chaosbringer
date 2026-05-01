import { describe, expect, it } from "vitest";
import { axe, buildAxeRunPayload, formatAxeViolations, invariants } from "./invariants.js";

describe("buildAxeRunPayload", () => {
  it("defaults to the WCAG 2 A / AA tags when none are provided", () => {
    const p = buildAxeRunPayload();
    expect(p.options.runOnly).toEqual({
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
    });
    expect(p.context).toBeNull();
    expect(p.options.rules).toBeUndefined();
  });

  it("passes custom tags through verbatim", () => {
    const p = buildAxeRunPayload({ tags: ["best-practice"] });
    expect(p.options.runOnly.values).toEqual(["best-practice"]);
  });

  it("wraps include/exclude selectors into axe's nested-array context shape", () => {
    const p = buildAxeRunPayload({ include: ["main"], exclude: [".ads", "#third-party"] });
    expect(p.context).toEqual({
      include: [["main"]],
      exclude: [[".ads"], ["#third-party"]],
    });
  });

  it("emits a rules map when disableRules is non-empty", () => {
    const p = buildAxeRunPayload({ disableRules: ["color-contrast", "region"] });
    expect(p.options.rules).toEqual({
      "color-contrast": { enabled: false },
      region: { enabled: false },
    });
  });

  it("omits the rules map when disableRules is empty", () => {
    expect(buildAxeRunPayload({ disableRules: [] }).options.rules).toBeUndefined();
  });

  it("returns resultTypes restricted to violations (we don't ship passes/incomplete)", () => {
    expect(buildAxeRunPayload().options.resultTypes).toEqual(["violations"]);
  });
});

describe("formatAxeViolations", () => {
  it("returns an empty string for an empty list", () => {
    expect(formatAxeViolations([])).toBe("");
  });

  it("summarises each violation with node count and impact when available", () => {
    const out = formatAxeViolations([
      { id: "color-contrast", impact: "serious", nodes: [{}, {}, {}, {}, {}] },
      { id: "image-alt", impact: "critical", nodes: [{}, {}] },
    ]);
    expect(out).toBe(
      "2 a11y violations: color-contrast(×5, serious), image-alt(×2, critical)"
    );
  });

  it("omits impact when not provided", () => {
    const out = formatAxeViolations([{ id: "region", nodes: [{}] }]);
    expect(out).toBe("1 a11y violations: region(×1)");
  });
});

describe("axe() invariant factory", () => {
  it("returns an Invariant with a default name and afterActions phase", () => {
    const inv = axe();
    expect(inv.name).toBe("a11y-axe");
    expect(inv.when).toBe("afterActions");
    expect(typeof inv.check).toBe("function");
  });

  it("honours custom name / when / urlPattern", () => {
    const inv = axe({ name: "a11y-home", when: "afterLoad", urlPattern: /^http:\/\/x\/$/ });
    expect(inv.name).toBe("a11y-home");
    expect(inv.when).toBe("afterLoad");
    expect(inv.urlPattern).toBeInstanceOf(RegExp);
  });

  it("is re-exported as invariants.axe for ergonomic consumption", () => {
    expect(invariants.axe).toBe(axe);
  });
});
