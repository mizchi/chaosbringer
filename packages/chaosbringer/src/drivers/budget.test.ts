import { describe, expect, it } from "vitest";
import { DriverBudget } from "./budget.js";

describe("DriverBudget", () => {
  it("is unlimited by default", () => {
    const b = new DriverBudget();
    for (let i = 0; i < 100; i++) {
      expect(b.canCall("u")).toBe(true);
      b.recordCall("u");
    }
  });

  it("caps total calls", () => {
    const b = new DriverBudget({ maxCalls: 2 });
    expect(b.canCall("u")).toBe(true);
    b.recordCall("u");
    b.recordCall("u");
    expect(b.canCall("u")).toBe(false);
  });

  it("caps per-page calls and resets on resetPage", () => {
    const b = new DriverBudget({ maxCallsPerPage: 1 });
    expect(b.canCall("a")).toBe(true);
    b.recordCall("a");
    expect(b.canCall("a")).toBe(false);
    expect(b.canCall("b")).toBe(true); // different page still has budget
    b.resetPage("a");
    expect(b.canCall("a")).toBe(true);
  });

  it("caps USD spending", () => {
    const b = new DriverBudget({ maxUsd: 0.01 });
    expect(b.canCall("u")).toBe(true);
    b.recordUsd(0.02);
    expect(b.canCall("u")).toBe(false);
  });

  it("reports remaining budget when capped", () => {
    const b = new DriverBudget({ maxCalls: 5, maxUsd: 1 });
    b.recordCall("u");
    b.recordUsd(0.25);
    expect(b.remainingCalls()).toBe(4);
    expect(b.remainingUsd()).toBeCloseTo(0.75);
  });

  it("returns undefined remaining when uncapped", () => {
    const b = new DriverBudget();
    expect(b.remainingCalls()).toBeUndefined();
    expect(b.remainingUsd()).toBeUndefined();
  });
});
