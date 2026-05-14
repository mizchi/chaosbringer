import { describe, expect, it } from "vitest";
import { investigateGoal } from "./goals.js";
import type { GoalContext } from "./types.js";

function ctx(overrides: Partial<GoalContext>): GoalContext {
  return {
    page: {} as GoalContext["page"],
    url: "https://x/",
    history: [],
    errors: [],
    ...overrides,
  };
}

describe("investigateGoal", () => {
  it("includes error context inside the objective string", () => {
    const goal = investigateGoal({
      url: "https://x/checkout",
      signature: "checkout-500",
      errorMessages: ["TypeError: undefined is not a function"],
      notes: "happened after enabling api-500",
    });
    expect(goal.objective).toContain("https://x/checkout");
    expect(goal.objective).toContain("api-500");
    expect(goal.objective).toContain("TypeError");
  });

  it("default successCheck returns true when URL matches AND errors present", async () => {
    const goal = investigateGoal({
      url: "https://x/checkout",
      signature: "checkout-500",
    });
    // wrong URL → false
    expect(
      await goal.successCheck(
        ctx({ url: "https://x/", errors: [{ message: "boom", timestamp: 0 }] }),
      ),
    ).toBe(false);
    // right URL but no errors → false
    expect(await goal.successCheck(ctx({ url: "https://x/checkout" }))).toBe(false);
    // both → true
    expect(
      await goal.successCheck(
        ctx({ url: "https://x/checkout", errors: [{ message: "boom", timestamp: 0 }] }),
      ),
    ).toBe(true);
  });

  it("custom reproducedCheck overrides the default", async () => {
    const goal = investigateGoal(
      { url: "https://x/p", signature: "p" },
      { reproducedCheck: async () => true },
    );
    expect(await goal.successCheck(ctx({}))).toBe(true);
  });

  it("tolerates a relative-path 'url' (no URL.parse)", () => {
    const goal = investigateGoal({ url: "/relative/path", signature: "rel" });
    expect(goal.objective).toContain("/relative/path");
  });

  it("trims long error messages in the objective", () => {
    const long = "x".repeat(500);
    const goal = investigateGoal({
      url: "/p",
      signature: "p",
      errorMessages: [long],
    });
    // The trimmer caps at ~120 chars + ellipsis; the full message must
    // not be in the prompt.
    expect(goal.objective.includes(long)).toBe(false);
    expect(goal.objective).toContain("...");
  });
});
