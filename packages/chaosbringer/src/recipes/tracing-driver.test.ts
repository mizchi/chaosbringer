import { describe, expect, it } from "vitest";
import { tracingDriver } from "./tracing-driver.js";
import type { Driver, DriverPick, DriverStep } from "../drivers/types.js";
import type { ActionResult } from "../types.js";
import type { Goal } from "./types.js";

/**
 * Minimal stub `DriverStep`. Tests don't touch the page handle — the
 * tracing driver only calls `page.url()` and `page.on()`. We provide
 * a no-op event emitter so installErrorHook doesn't throw.
 */
function fakeStep(url: string): DriverStep {
  return {
    url,
    page: {
      url: () => url,
      on: () => {},
    } as unknown as DriverStep["page"],
    candidates: [
      { index: 0, selector: "[data-test=a]", description: "btn a", type: "button", weight: 1 },
    ],
    history: [],
    stepIndex: 0,
    rng: { next: () => 0.5 } as DriverStep["rng"],
    screenshot: async () => Buffer.from(""),
    invariantViolations: [],
  };
}

function scriptedDriver(picks: ReadonlyArray<DriverPick | null>): Driver {
  let i = 0;
  return {
    name: "scripted",
    async selectAction() {
      return picks[i++] ?? null;
    },
  };
}

function clickResult(selector: string, success = true): ActionResult {
  return { type: "click", selector, success, timestamp: Date.now() };
}

function navResult(target: string): ActionResult {
  return { type: "navigate", target, success: true, timestamp: Date.now() };
}

function inputResult(selector: string): ActionResult {
  return { type: "input", selector, target: "test input", success: true, timestamp: Date.now() };
}

describe("tracingDriver", () => {
  it("accumulates click actions into the trace", async () => {
    const goal: Goal = {
      name: "g",
      persona: "p",
      objective: "o",
      successCheck: async () => false,
    };
    const inner = scriptedDriver([{ kind: "select", index: 0 }]);
    const driver = tracingDriver({ inner, goal });

    const step = fakeStep("https://x/");
    const pick = await driver.selectAction(step);
    expect(pick).toEqual({ kind: "select", index: 0 });

    driver.onActionComplete?.(clickResult("[data-test=a]"), step);
    const trace = driver.getTrace();
    expect(trace.steps).toEqual([{ kind: "click", selector: "[data-test=a]" }]);
    expect(trace.successful).toBe(false);
  });

  it("captures navigate actions with absolute URL", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({ inner: scriptedDriver([null]), goal });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(navResult("/about"), step);
    expect(driver.getTrace().steps).toEqual([{ kind: "navigate", url: "https://x/about" }]);
  });

  it("captures input actions as 'fill' with the default 'test input' value", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({ inner: scriptedDriver([null]), goal });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(inputResult("[name=email]"), step);
    expect(driver.getTrace().steps).toEqual([
      { kind: "fill", selector: "[name=email]", value: "test input" },
    ]);
  });

  it("honours fillValueFor for callers that know real values", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({
      inner: scriptedDriver([null]),
      goal,
      fillValueFor: (sel) => (sel.includes("email") ? "alice@example.com" : undefined),
    });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(inputResult("[name=email]"), step);
    expect(driver.getTrace().steps[0]).toEqual({
      kind: "fill",
      selector: "[name=email]",
      value: "alice@example.com",
    });
  });

  it("skips actions it cannot translate (scroll / hover)", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({ inner: scriptedDriver([null]), goal });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(
      { type: "scroll", success: true, timestamp: Date.now() },
      step,
    );
    expect(driver.getTrace().steps.length).toBe(0);
  });

  it("drops failed actions — only successful ones get into the trace", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({ inner: scriptedDriver([null]), goal });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(clickResult("[data-test=a]", false), step);
    expect(driver.getTrace().steps.length).toBe(0);
  });

  it("calls onTraceComplete exactly once when successCheck flips true", async () => {
    let calls = 0;
    let captured = false;
    const goal: Goal = {
      name: "g",
      persona: "p",
      objective: "o",
      successCheck: async () => captured,
    };
    const driver = tracingDriver({
      inner: scriptedDriver([{ kind: "select", index: 0 }, { kind: "select", index: 0 }]),
      goal,
      onTraceComplete: async () => { calls += 1; },
    });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(clickResult("[data-test=a]"), step);
    expect(calls).toBe(0);
    expect(driver.getTrace().successful).toBe(false);

    captured = true;
    await driver.selectAction(step);
    // Second call also flips through successCheck — onTraceComplete must NOT re-fire.
    await driver.selectAction(step);

    expect(calls).toBe(1);
    expect(driver.getTrace().successful).toBe(true);
  });

  it("reset() clears the accumulated trace", async () => {
    const goal: Goal = {
      name: "g", persona: "p", objective: "o", successCheck: async () => false,
    };
    const driver = tracingDriver({ inner: scriptedDriver([null, null]), goal });
    const step = fakeStep("https://x/");
    await driver.selectAction(step);
    driver.onActionComplete?.(clickResult("a"), step);
    expect(driver.getTrace().steps.length).toBe(1);
    driver.reset();
    await driver.selectAction(step);
    expect(driver.getTrace().steps.length).toBe(0);
  });
});
