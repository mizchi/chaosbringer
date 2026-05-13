import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import { advisorFallbackDriver } from "./advisor-fallback.js";
import type { Driver, DriverPick, DriverStep } from "./types.js";

const makeStep = (overrides: Partial<DriverStep> = {}): DriverStep => ({
  url: "https://example.test/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: {} as any,
  candidates: [
    { index: 0, selector: "#a", description: "a", type: "button", weight: 1 },
    { index: 1, selector: "#b", description: "b", type: "button", weight: 1 },
  ],
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => Buffer.from([]),
  invariantViolations: [],
  ...overrides,
});

const fixedDriver = (name: string, pick: DriverPick | null): Driver => ({
  name,
  selectAction: vi.fn(async () => pick),
});

describe("advisorFallbackDriver", () => {
  it("calls only the primary in the steady state", async () => {
    const primary = fixedDriver("primary", { kind: "select", index: 0 });
    const fallback = fixedDriver("fallback", { kind: "select", index: 1 });
    const { driver, signal } = advisorFallbackDriver({ primary, fallback });
    for (let i = 0; i < 3; i++) {
      signal.recordNovelty(true);
      await driver.selectAction(makeStep());
    }
    expect(primary.selectAction).toHaveBeenCalledTimes(3);
    expect(fallback.selectAction).not.toHaveBeenCalled();
  });

  it("invokes fallback after N zero-novelty actions", async () => {
    const primary = fixedDriver("primary", { kind: "select", index: 0 });
    const fallback = fixedDriver("fallback", { kind: "select", index: 1 });
    const { driver, signal } = advisorFallbackDriver({
      primary,
      fallback,
      noveltyStallThreshold: 2,
    });
    signal.recordNovelty(false);
    signal.recordNovelty(false);
    const pick = await driver.selectAction(makeStep());
    expect(pick).toEqual({ kind: "select", index: 1 });
    expect(fallback.selectAction).toHaveBeenCalledTimes(1);
  });

  it("invokes fallback when an invariant violation is pending", async () => {
    const primary = fixedDriver("primary", { kind: "select", index: 0 });
    const fallback = fixedDriver("fallback", { kind: "select", index: 1 });
    const { driver } = advisorFallbackDriver({ primary, fallback });
    const pick = await driver.selectAction(
      makeStep({
        invariantViolations: [{ name: "has-h1", message: "no h1" }],
      }),
    );
    expect(pick).toEqual({ kind: "select", index: 1 });
  });

  it("falls through to primary when fallback declines", async () => {
    const primary = fixedDriver("primary", { kind: "select", index: 0 });
    const fallback = fixedDriver("fallback", null);
    const { driver } = advisorFallbackDriver({ primary, fallback });
    const pick = await driver.selectAction(
      makeStep({
        invariantViolations: [{ name: "x", message: "y" }],
      }),
    );
    expect(pick).toEqual({ kind: "select", index: 0 });
    expect(primary.selectAction).toHaveBeenCalled();
  });

  it("consultNow() forces a single fallback consultation", async () => {
    const primary = fixedDriver("primary", { kind: "select", index: 0 });
    const fallback = fixedDriver("fallback", { kind: "select", index: 1 });
    const { driver, signal } = advisorFallbackDriver({
      primary,
      fallback,
      noveltyStallThreshold: 100,
    });
    signal.consultNow();
    expect(await driver.selectAction(makeStep())).toEqual({ kind: "select", index: 1 });
    // Subsequent steps revert to primary without an explicit signal.
    expect(await driver.selectAction(makeStep())).toEqual({ kind: "select", index: 0 });
  });
});
