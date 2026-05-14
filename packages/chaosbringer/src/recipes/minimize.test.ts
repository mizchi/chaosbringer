/**
 * Pure-logic tests for `minimizeRecipeTrace`. We don't touch a real
 * Page — the predicate (`successCheck` override) decides reproduction
 * directly, and `setupPage` returns a fake-but-API-compatible Page so
 * the `runRecipe` calls inside don't throw.
 *
 * The fake Page logs which step kinds were executed; the predicate
 * inspects that log to decide "did the required step run".
 */
import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { minimizeRecipeTrace } from "./minimize.js";
import type { ActionTrace, RecipeStep, GoalContext } from "./types.js";

function makeFakePage(): { page: Page; clicks: string[] } {
  const clicks: string[] = [];
  // Track URL state from `navigate` so the goal predicate can match it.
  let currentUrl = "https://x/";
  const page = {
    url: () => currentUrl,
    click: async (selector: string) => {
      clicks.push(selector);
    },
    fill: async (selector: string, _v: string) => {
      clicks.push(`fill:${selector}`);
    },
    goto: async (url: string) => {
      currentUrl = url;
      clicks.push(`goto:${url}`);
    },
    keyboard: { press: async () => {} },
    locator: () => ({ press: async () => {}, first: () => ({ isVisible: async () => false }) }),
    selectOption: async () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    viewportSize: () => null,
    mouse: { click: async () => {} },
  } as unknown as Page;
  return { page, clicks };
}

function trace(steps: RecipeStep[]): ActionTrace {
  return {
    goal: "investigate",
    steps,
    startState: { url: "https://x/" },
    endState: { url: "https://x/broken" },
    durationMs: 0,
    successful: true,
  };
}

describe("minimizeRecipeTrace", () => {
  it("returns the original when no step can be removed", async () => {
    // Goal: page url must contain "/c" AND `clicks` must include "[b]"
    let lastClicks: string[] = [];
    const factory = () => {
      const { page, clicks } = makeFakePage();
      lastClicks = clicks;
      return Promise.resolve({ page, cleanup: async () => {} });
    };
    const result = await minimizeRecipeTrace({
      trace: trace([
        { kind: "navigate", url: "https://x/c" },
        { kind: "click", selector: "[b]" },
      ]),
      goal: {
        name: "g", persona: "p", objective: "o",
        successCheck: async (ctx: GoalContext) => ctx.url.includes("/c") && lastClicks.includes("[b]"),
      },
      setupPage: factory,
      verbose: false,
    });
    expect(result.shrank).toBe(false);
    expect(result.minimizedLength).toBe(2);
    expect(result.reason).toBe("converged");
  });

  it("removes redundant steps", async () => {
    // Two clicks redundant, one essential. Predicate fires only when
    // the "essential" click is in the log.
    let lastClicks: string[] = [];
    const factory = () => {
      const { page, clicks } = makeFakePage();
      lastClicks = clicks;
      return Promise.resolve({ page, cleanup: async () => {} });
    };
    const result = await minimizeRecipeTrace({
      trace: trace([
        { kind: "click", selector: "[redundant-1]" },
        { kind: "click", selector: "[essential]" },
        { kind: "click", selector: "[redundant-2]" },
        { kind: "click", selector: "[redundant-3]" },
      ]),
      goal: {
        name: "g", persona: "p", objective: "o",
        successCheck: async () => lastClicks.includes("[essential]"),
      },
      setupPage: factory,
    });
    expect(result.shrank).toBe(true);
    expect(result.minimizedLength).toBe(1);
    expect(result.steps).toEqual([{ kind: "click", selector: "[essential]" }]);
  });

  it("handles an empty-step reproduction (initial-load failure)", async () => {
    // Goal already fires on the freshly-navigated page (no clicks needed).
    const factory = () => {
      const { page } = makeFakePage();
      return Promise.resolve({ page, cleanup: async () => {} });
    };
    const result = await minimizeRecipeTrace({
      trace: trace([
        { kind: "click", selector: "[a]" },
        { kind: "click", selector: "[b]" },
      ]),
      goal: {
        name: "g", persona: "p", objective: "o",
        successCheck: async () => true, // always
      },
      setupPage: factory,
    });
    expect(result.minimizedLength).toBe(0);
    expect(result.steps).toEqual([]);
  });

  it("rejects an unsuccessful trace", async () => {
    await expect(
      minimizeRecipeTrace({
        trace: { ...trace([]), successful: false },
        goal: {
          name: "g", persona: "p", objective: "o",
          successCheck: async () => true,
        },
        setupPage: async () => ({ page: makeFakePage().page, cleanup: async () => {} }),
      }),
    ).rejects.toThrow(/unsuccessful/);
  });

  it("stops at maxReplays and reports reason='budget'", async () => {
    // 5 steps; predicate is satisfied by exactly { kind: 'click', '[needed]' }
    // exists. With budget 1 we cannot complete the scan.
    let lastClicks: string[] = [];
    const factory = () => {
      const { page, clicks } = makeFakePage();
      lastClicks = clicks;
      return Promise.resolve({ page, cleanup: async () => {} });
    };
    const result = await minimizeRecipeTrace({
      trace: trace([
        { kind: "click", selector: "[a]" },
        { kind: "click", selector: "[b]" },
        { kind: "click", selector: "[needed]" },
        { kind: "click", selector: "[d]" },
        { kind: "click", selector: "[e]" },
      ]),
      goal: {
        name: "g", persona: "p", objective: "o",
        successCheck: async () => lastClicks.includes("[needed]"),
      },
      setupPage: factory,
      maxReplays: 1,
    });
    expect(result.reason).toBe("budget");
  });
});
