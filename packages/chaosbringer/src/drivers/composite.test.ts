import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import { compositeDriver, probabilityDriver, samplingDriver } from "./composite.js";
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
  async selectAction() {
    return pick;
  },
});

describe("compositeDriver", () => {
  it("returns the first non-null pick", async () => {
    const d = compositeDriver([
      fixedDriver("a", null),
      fixedDriver("b", { kind: "select", index: 1 }),
      fixedDriver("c", { kind: "select", index: 0 }),
    ]);
    const pick = await d.selectAction(makeStep());
    expect(pick).toEqual({ kind: "select", index: 1 });
  });

  it("returns null when every child declines", async () => {
    const d = compositeDriver([fixedDriver("a", null), fixedDriver("b", null)]);
    expect(await d.selectAction(makeStep())).toBeNull();
  });

  it("respects a deliberate skip from an upstream driver", async () => {
    const d = compositeDriver([
      fixedDriver("a", { kind: "skip" }),
      fixedDriver("b", { kind: "select", index: 0 }),
    ]);
    expect(await d.selectAction(makeStep())).toEqual({ kind: "skip" });
  });

  it("propagates lifecycle hooks to every child", async () => {
    const onStart = vi.fn();
    const child: Driver = {
      name: "child",
      async selectAction() {
        return null;
      },
      onPageStart: onStart,
    };
    const d = compositeDriver([child, child]);
    d.onPageStart?.("https://x");
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty list", () => {
    expect(() => compositeDriver([])).toThrow();
  });
});

describe("samplingDriver", () => {
  it("invokes the inner driver every N steps", async () => {
    const inner = vi.fn(async () => ({ kind: "select", index: 0 }) as DriverPick);
    const d = samplingDriver({
      driver: { name: "inner", selectAction: inner },
      every: 3,
    });
    for (let i = 0; i < 9; i++) {
      await d.selectAction(makeStep({ stepIndex: i }));
    }
    // Should fire at steps 0, 3, 6 — 3 invocations.
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("returns null on non-sampled steps", async () => {
    const inner = vi.fn(async () => ({ kind: "select", index: 0 }) as DriverPick);
    const d = samplingDriver({
      driver: { name: "inner", selectAction: inner },
      every: 5,
    });
    expect(await d.selectAction(makeStep({ stepIndex: 1 }))).toBeNull();
    expect(inner).not.toHaveBeenCalled();
  });

  it("disables when every <= 0", async () => {
    const inner = vi.fn(async () => null);
    const d = samplingDriver({
      driver: { name: "inner", selectAction: inner },
      every: 0,
    });
    expect(await d.selectAction(makeStep())).toBeNull();
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("probabilityDriver", () => {
  it("never fires when probability is 0", async () => {
    const inner = vi.fn(async () => ({ kind: "select", index: 0 }) as DriverPick);
    const d = probabilityDriver({
      driver: { name: "inner", selectAction: inner },
      probability: 0,
    });
    for (let i = 0; i < 5; i++) {
      await d.selectAction(makeStep({ rng: createRng(i + 1) }));
    }
    expect(inner).not.toHaveBeenCalled();
  });

  it("always fires when probability is 1", async () => {
    const inner = vi.fn(async () => ({ kind: "select", index: 0 }) as DriverPick);
    const d = probabilityDriver({
      driver: { name: "inner", selectAction: inner },
      probability: 1,
    });
    for (let i = 0; i < 5; i++) {
      await d.selectAction(makeStep({ rng: createRng(i + 1) }));
    }
    expect(inner).toHaveBeenCalledTimes(5);
  });
});
