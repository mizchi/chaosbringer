import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import { flowDriver } from "./flow-driver.js";
import type { DriverStep } from "./types.js";

const makeStep = (overrides: Partial<DriverStep> = {}): DriverStep => ({
  url: "https://example.test/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: {} as any,
  candidates: [{ index: 0, selector: "#a", description: "a", type: "button", weight: 1 }],
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => Buffer.from([]),
  invariantViolations: [],
  ...overrides,
});

describe("flowDriver", () => {
  it("returns null when no step matches the URL", async () => {
    const driver = flowDriver({
      steps: [
        { name: "login", urlPattern: /\/login$/, run: async () => {} },
      ],
    });
    expect(await driver.selectAction(makeStep({ url: "https://x/home" }))).toBeNull();
  });

  it("advances cursor on success", async () => {
    const run1 = vi.fn(async () => {});
    const run2 = vi.fn(async () => {});
    const driver = flowDriver({
      steps: [
        { name: "a", urlPattern: /\//, run: run1 },
        { name: "b", urlPattern: /\//, run: run2 },
      ],
    });

    // First call: step a is picked.
    const p1 = await driver.selectAction(makeStep());
    expect(p1?.kind).toBe("custom");
    if (p1?.kind === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await p1.perform({} as any);
      expect(result.success).toBe(true);
      expect(run1).toHaveBeenCalled();
    }

    // Second call: step b is picked.
    const p2 = await driver.selectAction(makeStep());
    expect(p2?.kind).toBe("custom");
    if (p2?.kind === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await p2.perform({} as any);
      expect(run2).toHaveBeenCalled();
    }

    // Third call: out of steps.
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("halts after a non-optional step throws", async () => {
    const driver = flowDriver({
      steps: [
        {
          name: "boom",
          urlPattern: /\//,
          run: async () => {
            throw new Error("nope");
          },
        },
        { name: "next", urlPattern: /\//, run: vi.fn(async () => {}) },
      ],
    });
    const pick = await driver.selectAction(makeStep());
    if (pick?.kind === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await pick.perform({} as any);
      expect(r.success).toBe(false);
    }
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("continues past an optional failing step", async () => {
    const after = vi.fn(async () => {});
    const driver = flowDriver({
      steps: [
        {
          name: "opt",
          optional: true,
          urlPattern: /\//,
          run: async () => {
            throw new Error("nope");
          },
        },
        { name: "after", urlPattern: /\//, run: after },
      ],
    });
    const p1 = await driver.selectAction(makeStep());
    if (p1?.kind === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await p1.perform({} as any);
    }
    const p2 = await driver.selectAction(makeStep());
    if (p2?.kind === "custom") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await p2.perform({} as any);
    }
    expect(after).toHaveBeenCalled();
  });

  it("loops when loop: true", async () => {
    const run = vi.fn(async () => {});
    const driver = flowDriver({
      loop: true,
      steps: [{ name: "x", urlPattern: /\//, run }],
    });
    for (let i = 0; i < 3; i++) {
      const p = await driver.selectAction(makeStep());
      if (p?.kind === "custom") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await p.perform({} as any);
      }
    }
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("uses custom when predicate when supplied", async () => {
    const driver = flowDriver({
      steps: [
        {
          name: "by-title",
          when: () => false,
          run: async () => {},
        },
      ],
    });
    expect(await driver.selectAction(makeStep())).toBeNull();
  });

  it("throws on empty steps", () => {
    expect(() => flowDriver({ steps: [] })).toThrow();
  });
});
