import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import { aiDriver } from "./ai-driver.js";
import { DriverBudget } from "./budget.js";
import type { DriverProvider, DriverStep } from "./types.js";

const PNG = Buffer.from([0x89, 0x50]);

const makeStep = (overrides: Partial<DriverStep> = {}): DriverStep => ({
  url: "https://example.test/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: {} as any,
  candidates: [
    { index: 0, selector: "#a", description: "a", type: "button", weight: 1 },
    { index: 1, selector: "#b", description: "b", type: "button", weight: 1 },
    { index: 2, selector: "#c", description: "c", type: "input", weight: 1 },
  ],
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => PNG,
  invariantViolations: [],
  ...overrides,
});

const fixedProvider = (
  result: { index: number; reasoning: string } | null,
): DriverProvider => ({
  name: "test/provider",
  selectAction: vi.fn(async () => result),
});

describe("aiDriver", () => {
  it("returns the provider's pick verbatim", async () => {
    const provider = fixedProvider({ index: 2, reasoning: "try the input" });
    const driver = aiDriver({ provider });
    const pick = await driver.selectAction(makeStep());
    expect(pick).toEqual({
      kind: "select",
      index: 2,
      reasoning: "try the input",
      source: "test/provider",
    });
  });

  it("returns null when fewer than minCandidatesToConsult candidates", async () => {
    const provider = fixedProvider({ index: 0, reasoning: "x" });
    const driver = aiDriver({ provider, minCandidatesToConsult: 5 });
    expect(await driver.selectAction(makeStep())).toBeNull();
    expect(provider.selectAction).not.toHaveBeenCalled();
  });

  it("respects a budget cap on calls", async () => {
    const provider = fixedProvider({ index: 0, reasoning: "x" });
    const budget = new DriverBudget({ maxCalls: 2 });
    const driver = aiDriver({ provider, budget });
    await driver.selectAction(makeStep());
    await driver.selectAction(makeStep());
    const third = await driver.selectAction(makeStep());
    expect(third).toBeNull();
    expect(provider.selectAction).toHaveBeenCalledTimes(2);
  });

  it("returns null when the provider's index is out of range", async () => {
    const driver = aiDriver({ provider: fixedProvider({ index: 99, reasoning: "x" }) });
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("returns null when the provider throws", async () => {
    const provider: DriverProvider = {
      name: "boom",
      async selectAction() {
        throw new Error("network");
      },
    };
    const driver = aiDriver({ provider });
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("times out a slow provider", async () => {
    const provider: DriverProvider = {
      name: "slow",
      selectAction: () => new Promise(() => {}),
    };
    const driver = aiDriver({ provider, timeoutMs: 10 });
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("resets per-page budget on onPageStart", async () => {
    const provider = fixedProvider({ index: 0, reasoning: "x" });
    const budget = new DriverBudget({ maxCallsPerPage: 1 });
    const driver = aiDriver({ provider, budget });
    expect(await driver.selectAction(makeStep())).not.toBeNull();
    expect(await driver.selectAction(makeStep())).toBeNull();
    driver.onPageStart?.("https://example.test/");
    expect(await driver.selectAction(makeStep())).not.toBeNull();
  });
});
