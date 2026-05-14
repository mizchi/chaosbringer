import { describe, expect, it } from "vitest";
import {
  bugHuntingGoal,
  completionBySelector,
  completionByUrl,
  completionGoal,
  coverageGoal,
  goals,
} from "./goals.js";
import type { GoalContext } from "./types.js";

function mkCtx(overrides: Partial<GoalContext> = {}): GoalContext {
  return {
    page: {} as GoalContext["page"],
    url: "https://x/",
    history: [],
    errors: [],
    ...overrides,
  };
}

describe("completionGoal", () => {
  it("forwards task as objective", () => {
    const g = completionGoal({
      task: "Buy a t-shirt",
      successCheck: async () => false,
    });
    expect(g.name).toBe("completion");
    expect(g.objective).toBe("Buy a t-shirt");
    expect(g.budget?.maxSteps).toBeGreaterThan(0);
  });

  it("persona is overridable", () => {
    const g = completionGoal({
      task: "x",
      persona: "expert user",
      successCheck: async () => false,
    });
    expect(g.persona).toBe("expert user");
  });
});

describe("bugHuntingGoal", () => {
  it("default success is 'errors.length > 0'", async () => {
    const g = bugHuntingGoal();
    expect(await g.successCheck(mkCtx())).toBe(false);
    expect(
      await g.successCheck(mkCtx({ errors: [{ message: "boom", timestamp: 1 }] })),
    ).toBe(true);
  });

  it("focus is injected into the objective", () => {
    const g = bugHuntingGoal({ focus: "the checkout flow" });
    expect(g.objective).toMatch(/checkout flow/);
  });
});

describe("coverageGoal", () => {
  it("counts distinct selectors and reports success at the target", async () => {
    const g = coverageGoal({ targetSelectors: 3 });
    const history = [
      { kind: "click", selector: "a" } as const,
      { kind: "click", selector: "b" } as const,
      { kind: "click", selector: "a" } as const,   // duplicate
      { kind: "click", selector: "c" } as const,
    ];
    expect(await g.successCheck(mkCtx({ history: history.slice(0, 2) }))).toBe(false);
    expect(await g.successCheck(mkCtx({ history }))).toBe(true);
  });
});

describe("completionByUrl / completionBySelector", () => {
  it("byUrl returns true when needle is contained", async () => {
    const check = completionByUrl("/thanks");
    expect(await check(mkCtx({ url: "https://x/thanks" }))).toBe(true);
    expect(await check(mkCtx({ url: "https://x/" }))).toBe(false);
  });
});

describe("goals namespace", () => {
  it("exposes the same factories", () => {
    expect(goals.completion).toBe(completionGoal);
    expect(goals.bugHunting).toBe(bugHuntingGoal);
    expect(goals.coverage).toBe(coverageGoal);
    expect(goals.byUrl).toBe(completionByUrl);
    expect(goals.bySelector).toBe(completionBySelector);
  });
});
