import { describe, expect, it, vi } from "vitest";
import { AdvisorBudget, StallTracker } from "./budget.js";
import { consultAdvisor, type ConsultDeps } from "./consult.js";
import { defaultTriggerPolicy } from "./trigger.js";
import type { ActionAdvisor, AdvisorCandidate } from "./types.js";

const sampleScreenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const sampleCandidates = (): AdvisorCandidate[] => [
  { index: 0, selector: "#a", description: "button A" },
  { index: 1, selector: "#b", description: "button B" },
  { index: 2, selector: "#c", description: "button C" },
];

const makeProvider = (
  suggest: ActionAdvisor["suggest"],
  name = "mock",
): ActionAdvisor => ({
  name,
  suggest,
});

const baseDeps = (overrides: Partial<ConsultDeps> = {}): ConsultDeps => {
  const stall = new StallTracker();
  for (let i = 0; i < 5; i += 1) stall.recordZeroNovelty();
  return {
    state: {
      callsThisCrawl: 0,
      callsThisPage: 0,
      consecutiveZeroNovelty: stall.consecutiveZeroNovelty(),
      pendingInvariantViolation: stall.invariantViolationPending(),
    },
    policy: defaultTriggerPolicy(),
    budget: new AdvisorBudget(),
    provider: makeProvider(async () => ({ chosenIndex: 0, reasoning: "ok" })),
    url: "https://example.test/page",
    candidates: sampleCandidates(),
    screenshotSupplier: async () => sampleScreenshot,
    timeoutMs: 1_000,
    ...overrides,
  };
};

describe("consultAdvisor", () => {
  it("returns null without calling the provider when trigger declines", async () => {
    const provider = makeProvider(vi.fn(async () => ({ chosenIndex: 0, reasoning: "x" })));
    const deps = baseDeps({
      provider,
      state: {
        callsThisCrawl: 0,
        callsThisPage: 0,
        consecutiveZeroNovelty: 0,
        pendingInvariantViolation: false,
      },
    });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("skipped");
    expect(result.suggestion).toBeNull();
    expect(provider.suggest).not.toHaveBeenCalled();
    expect(deps.budget.callsThisCrawl()).toBe(0);
  });

  it("does not request a screenshot when trigger declines", async () => {
    const screenshotSupplier = vi.fn(async () => sampleScreenshot);
    const deps = baseDeps({
      screenshotSupplier,
      state: {
        callsThisCrawl: 0,
        callsThisPage: 0,
        consecutiveZeroNovelty: 0,
        pendingInvariantViolation: false,
      },
    });
    await consultAdvisor(deps);
    expect(screenshotSupplier).not.toHaveBeenCalled();
  });

  it("calls the provider and records budget on success", async () => {
    const deps = baseDeps();
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("consulted");
    expect(result.suggestion).toEqual({ chosenIndex: 0, reasoning: "ok" });
    expect(deps.budget.callsThisCrawl()).toBe(1);
    expect(deps.budget.callsThisPage(deps.url)).toBe(1);
  });

  it("treats provider returning null as soft_fail and still records budget", async () => {
    const deps = baseDeps({ provider: makeProvider(async () => null) });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("soft_fail");
    expect(result.suggestion).toBeNull();
    expect(deps.budget.callsThisCrawl()).toBe(1);
  });

  it("rejects out-of-range chosenIndex", async () => {
    const deps = baseDeps({
      provider: makeProvider(async () => ({ chosenIndex: 99, reasoning: "bad" })),
    });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("out_of_range");
    expect(result.suggestion).toBeNull();
    expect(deps.budget.callsThisCrawl()).toBe(1);
  });

  it("rejects negative chosenIndex", async () => {
    const deps = baseDeps({
      provider: makeProvider(async () => ({ chosenIndex: -1, reasoning: "bad" })),
    });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("out_of_range");
  });

  it("catches provider throws and records budget", async () => {
    const deps = baseDeps({
      provider: makeProvider(async () => {
        throw new Error("boom");
      }),
    });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("threw");
    expect(result.suggestion).toBeNull();
    expect(deps.budget.callsThisCrawl()).toBe(1);
  });

  it("returns timeout when provider exceeds timeoutMs", async () => {
    const deps = baseDeps({
      timeoutMs: 30,
      provider: makeProvider(
        () => new Promise((resolve) => setTimeout(() => resolve({ chosenIndex: 0, reasoning: "late" }), 200)),
      ),
    });
    const result = await consultAdvisor(deps);
    expect(result.outcome).toBe("timeout");
    expect(result.suggestion).toBeNull();
    expect(deps.budget.callsThisCrawl()).toBe(1);
  });

  it("passes through reason from trigger decision into the context", async () => {
    const seen: string[] = [];
    const deps = baseDeps({
      provider: makeProvider(async (ctx) => {
        seen.push(ctx.reason);
        return { chosenIndex: 0, reasoning: "ok" };
      }),
      state: {
        callsThisCrawl: 0,
        callsThisPage: 0,
        consecutiveZeroNovelty: 0,
        pendingInvariantViolation: true,
      },
    });
    await consultAdvisor(deps);
    expect(seen).toEqual(["invariant_violation"]);
  });

  it("computes budgetRemaining from the policy minus current crawl-wide calls", async () => {
    const seen: number[] = [];
    const budget = new AdvisorBudget();
    budget.recordCall("https://example.test/page");
    budget.recordCall("https://example.test/page");
    const deps = baseDeps({
      budget,
      state: {
        callsThisCrawl: 2,
        callsThisPage: 2,
        consecutiveZeroNovelty: 5,
        pendingInvariantViolation: false,
      },
      provider: makeProvider(async (ctx) => {
        seen.push(ctx.budgetRemaining);
        return { chosenIndex: 0, reasoning: "ok" };
      }),
    });
    await consultAdvisor(deps);
    expect(seen).toEqual([20 - 2 - 1]);
  });
});
