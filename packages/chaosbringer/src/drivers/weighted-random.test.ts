import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import { weightedRandomDriver } from "./weighted-random.js";
import type { DriverStep } from "./types.js";

const makeStep = (overrides: Partial<DriverStep> = {}): DriverStep => ({
  url: "https://example.test/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: {} as any,
  candidates: [
    { index: 0, selector: "#a", description: "a", type: "button", weight: 1 },
    { index: 1, selector: "#b", description: "b", type: "button", weight: 100 },
  ],
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => Buffer.from([]),
  invariantViolations: [],
  ...overrides,
});

describe("weightedRandomDriver", () => {
  it("returns a select pick with index within candidates", async () => {
    const driver = weightedRandomDriver();
    const pick = await driver.selectAction(makeStep());
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("select");
    if (pick!.kind === "select") {
      expect([0, 1]).toContain(pick.index);
    }
  });

  it("biases heavily toward the higher weight", async () => {
    const driver = weightedRandomDriver();
    let zero = 0;
    let one = 0;
    for (let i = 0; i < 200; i++) {
      const pick = await driver.selectAction(makeStep({ rng: createRng(i + 1) }));
      if (pick && pick.kind === "select") {
        if (pick.index === 0) zero++;
        else if (pick.index === 1) one++;
      }
    }
    // Weight ratio is 1:100 — index 1 should dominate by a wide margin.
    expect(one).toBeGreaterThan(zero * 10);
  });

  it("returns null when there are no candidates", async () => {
    const driver = weightedRandomDriver();
    const pick = await driver.selectAction(makeStep({ candidates: [] }));
    expect(pick).toBeNull();
  });

  it("honors a custom weightOf transform", async () => {
    const driver = weightedRandomDriver({
      weightOf: (c) => (c.index === 0 ? 1000 : 0),
    });
    const pick = await driver.selectAction(makeStep());
    expect(pick).toEqual(
      expect.objectContaining({ kind: "select", index: 0 }),
    );
  });
});
