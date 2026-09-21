import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import { aiDriver } from "./ai-driver.js";
import { DriverBudget } from "./budget.js";
import { isObstructed } from "./types.js";
import type { DriverProvider, DriverProviderCandidate, DriverStep } from "./types.js";

const PNG = Buffer.from([0x89, 0x50]);

const makeStep = (overrides: Partial<DriverStep> = {}): DriverStep => ({
  url: "https://example.test/",
  currentUrl: overrides.url ?? "https://example.test/",
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
  result: { index: number; reasoning: string; confidence?: number } | null,
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

  it("carries a reported confidence onto the pick", async () => {
    const driver = aiDriver({
      provider: fixedProvider({ index: 1, reasoning: "b looks right", confidence: 0.82 }),
    });
    expect(await driver.selectAction(makeStep())).toEqual({
      kind: "select",
      index: 1,
      reasoning: "b looks right",
      source: "test/provider",
      confidence: 0.82,
    });
  });

  it("drops a pick below minConfidence so a composite can fall through", async () => {
    const provider = fixedProvider({ index: 1, reasoning: "not sure", confidence: 0.42 });
    const driver = aiDriver({ provider, minConfidence: 0.5 });
    expect(await driver.selectAction(makeStep())).toBeNull();
    // The call was made and paid for — only the answer was declined.
    expect(provider.selectAction).toHaveBeenCalledTimes(1);
  });

  it("acts on a pick at exactly minConfidence", async () => {
    const driver = aiDriver({
      provider: fixedProvider({ index: 0, reasoning: "ok", confidence: 0.5 }),
      minConfidence: 0.5,
    });
    expect(await driver.selectAction(makeStep())).not.toBeNull();
  });

  it("does not gate a provider that reports no confidence", async () => {
    // Silence is not zero: gating on it would disable every provider that
    // does not happen to report the field.
    const driver = aiDriver({
      provider: fixedProvider({ index: 0, reasoning: "no confidence field" }),
      minConfidence: 0.9,
    });
    const pick = await driver.selectAction(makeStep());
    expect(pick).not.toBeNull();
    expect(pick).not.toHaveProperty("confidence");
  });

  it("does not capture a screenshot for a provider that never asks", async () => {
    // The point of the thunk. A text-only provider used to pay for a
    // capture it could not read, and the capture ran before the provider
    // had been consulted at all.
    const screenshot = vi.fn(async () => PNG);
    const provider = fixedProvider({ index: 0, reasoning: "read the labels" });
    const driver = aiDriver({ provider });
    expect(await driver.selectAction(makeStep({ screenshot }))).not.toBeNull();
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("captures at the driver's configured mode when a provider asks", async () => {
    const screenshot = vi.fn(async () => PNG);
    const provider: DriverProvider = {
      name: "vision",
      async selectAction(input) {
        await input.screenshot();
        return { index: 0, reasoning: "looked" };
      },
    };
    const driver = aiDriver({ provider, screenshotMode: "fullPage" });
    await driver.selectAction(makeStep({ screenshot }));
    expect(screenshot).toHaveBeenCalledWith("fullPage");
  });

  it("lets a provider override the capture mode per call", async () => {
    const screenshot = vi.fn(async () => PNG);
    const provider: DriverProvider = {
      name: "vision",
      async selectAction(input) {
        await input.screenshot("viewport");
        return { index: 0, reasoning: "looked" };
      },
    };
    const driver = aiDriver({ provider, screenshotMode: "fullPage" });
    await driver.selectAction(makeStep({ screenshot }));
    expect(screenshot).toHaveBeenCalledWith("viewport");
  });

  it("treats a failed capture as the asking provider's soft failure", async () => {
    // Same outcome as before — the driver stands down — but now only for
    // providers that wanted pixels.
    const provider: DriverProvider = {
      name: "vision",
      async selectAction(input) {
        await input.screenshot();
        return { index: 0, reasoning: "unreachable" };
      },
    };
    const driver = aiDriver({ provider });
    const step = makeStep({
      screenshot: async () => {
        throw new Error("page closed");
      },
    });
    expect(await driver.selectAction(step)).toBeNull();
  });

  it("gives the provider the candidate facts, without the selector", async () => {
    let seen: DriverProviderCandidate[] = [];
    const provider: DriverProvider = {
      name: "inspect",
      async selectAction(input) {
        seen = [...input.candidates];
        return { index: 0, reasoning: "x" };
      },
    };
    await aiDriver({ provider }).selectAction(
      makeStep({
        candidates: [
          {
            index: 0,
            selector: "#covered",
            description: 'button "Continue"',
            type: "button",
            weight: 1,
            bbox: { x: 1, y: 2, width: 3, height: 4 },
            inViewport: true,
            coveredBy: "Accept cookies <div#consent-backdrop>",
          },
          { index: 1, selector: "#b", description: "b", type: "button", weight: 1 },
        ],
      }),
    );
    expect(seen).toEqual([
      {
        index: 0,
        description: 'button "Continue"',
        type: "button",
        weight: 1,
        bbox: { x: 1, y: 2, width: 3, height: 4 },
        inViewport: true,
        coveredBy: "Accept cookies <div#consent-backdrop>",
      },
      { index: 1, description: "b", type: "button", weight: 1 },
    ]);
    // The index is the whole mapping from answer to element, so the
    // selector stays on this side of the seam.
    for (const c of seen) expect(c).not.toHaveProperty("selector");
    // And the facts are usable as facts, from the provider's side.
    expect(isObstructed(seen[0])).toBe(true);
    expect(isObstructed(seen[1])).toBe(false);
  });

  it("leaves geometry keys absent rather than undefined", async () => {
    // The scroll target and a failed scrape both look like this, and
    // `isObstructed` distinguishes "nothing on top" from "not measured"
    // by reading `coveredBy !== undefined` — so an explicit `undefined`
    // would answer the wrong question.
    let seen: DriverProviderCandidate[] = [];
    const provider: DriverProvider = {
      name: "inspect",
      async selectAction(input) {
        seen = [...input.candidates];
        return { index: 0, reasoning: "x" };
      },
    };
    await aiDriver({ provider }).selectAction(makeStep());
    expect(seen[0]).not.toHaveProperty("coveredBy");
    expect(seen.every((c) => !isObstructed(c))).toBe(true);
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
