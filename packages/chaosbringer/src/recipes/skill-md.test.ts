import { describe, expect, it } from "vitest";
import {
  parseSkillMarkdown,
  seedToCandidateRecipe,
  seedToGoal,
} from "./skill-md.js";
import type { ActionTrace } from "./types.js";

const sample = `---
name: shop/buy-tshirt
goal: completion
urlPattern: ^https?://[^/]+/?$
success:
  urlContains: /thanks
  hasSelector: "[data-test=thanks]"
---
# Buy a T-shirt

1. Click any T-shirt.
2. On the product page, click Buy.
3. Land on /thanks.
`;

describe("parseSkillMarkdown", () => {
  it("parses frontmatter and body into a SkillSeed", () => {
    const seed = parseSkillMarkdown(sample);
    expect(seed.name).toBe("shop/buy-tshirt");
    expect(seed.goal).toBe("completion");
    expect(seed.urlPattern).toBe("^https?://[^/]+/?$");
    expect(seed.success?.urlContains).toBe("/thanks");
    expect(seed.success?.hasSelector).toBe("[data-test=thanks]");
    expect(seed.body).toMatch(/^# Buy a T-shirt/);
    expect(seed.body).toContain("Land on /thanks");
  });

  it("throws on missing frontmatter delimiters", () => {
    expect(() => parseSkillMarkdown("# just markdown")).toThrow(/frontmatter/);
  });

  it("throws on missing `name`", () => {
    expect(() => parseSkillMarkdown(`---\ngoal: x\n---\nbody`)).toThrow(/name/);
  });

  it("parses scalar types: string / int / bool / null", () => {
    const seed = parseSkillMarkdown(`---
name: x
n: 42
b: true
s: 'hello'
z: null
---
body`);
    expect(seed.raw.n).toBe(42);
    expect(seed.raw.b).toBe(true);
    expect(seed.raw.s).toBe("hello");
    expect(seed.raw.z).toBeNull();
  });

  it("ignores comments and blank lines in frontmatter", () => {
    const seed = parseSkillMarkdown(`---
# a comment
name: x

goal: completion
---
body`);
    expect(seed.name).toBe("x");
    expect(seed.goal).toBe("completion");
  });
});

describe("seedToGoal", () => {
  it("builds a Goal whose successCheck honours urlContains", async () => {
    const seed = parseSkillMarkdown(sample);
    const goal = seedToGoal(seed);
    expect(goal.name).toBe("completion");
    expect(goal.objective).toMatch(/Buy a T-shirt/);
    // Stub a GoalContext with the right URL but no selector — only
    // urlContains is checkable purely; selector check needs Page.
    const okUrl = await goal.successCheck({
      page: {
        locator: () => ({
          first: () => ({
            isVisible: async () => true,
          }),
        }),
      } as never,
      url: "https://x.test/thanks",
      history: [],
      errors: [],
    });
    expect(okUrl).toBe(true);
    const bad = await goal.successCheck({
      page: {
        locator: () => ({
          first: () => ({
            isVisible: async () => true,
          }),
        }),
      } as never,
      url: "https://x.test/",
      history: [],
      errors: [],
    });
    expect(bad).toBe(false);
  });
});

describe("seedToCandidateRecipe", () => {
  const trace: ActionTrace = {
    goal: "completion",
    steps: [
      { kind: "click", selector: "[data-test=tshirt]" },
      { kind: "click", selector: "[data-test=buy]" },
    ],
    startState: { url: "https://x.test/" },
    endState: { url: "https://x.test/thanks" },
    durationMs: 800,
    successful: true,
  };

  it("produces a candidate recipe with `markdown-seed` origin", () => {
    const seed = parseSkillMarkdown(sample);
    const recipe = seedToCandidateRecipe(seed, trace);
    expect(recipe.origin).toBe("markdown-seed");
    expect(recipe.status).toBe("candidate");
    expect(recipe.preconditions[0]?.urlPattern).toBe("^https?://[^/]+/?$");
    expect(recipe.steps.length).toBe(2);
    // `/` is not a regex metachar, so the escaper leaves it alone.
    expect(recipe.postconditions).toContainEqual({ urlPattern: "/thanks" });
    expect(recipe.postconditions).toContainEqual({ hasSelector: "[data-test=thanks]" });
  });

  it("throws on unsuccessful trace", () => {
    const seed = parseSkillMarkdown(sample);
    expect(() => seedToCandidateRecipe(seed, { ...trace, successful: false })).toThrow();
  });

  it("uses the first non-heading paragraph as description", () => {
    const md = `---\nname: x\n---\n# Heading\n\nFirst real line here.\n\nSecond line.\n`;
    const seed = parseSkillMarkdown(md);
    const recipe = seedToCandidateRecipe(seed, trace);
    expect(recipe.description).toBe("First real line here.");
  });
});
