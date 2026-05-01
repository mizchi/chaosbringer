import { describe, expect, it } from "vitest";
import { AdvisorBudget, StallTracker } from "./budget.js";

describe("AdvisorBudget", () => {
  it("starts with zero calls", () => {
    const b = new AdvisorBudget();
    expect(b.callsThisCrawl()).toBe(0);
    expect(b.callsThisPage("/foo")).toBe(0);
  });

  it("counts crawl-wide and per-page independently", () => {
    const b = new AdvisorBudget();
    b.recordCall("/foo");
    b.recordCall("/foo");
    b.recordCall("/bar");
    expect(b.callsThisCrawl()).toBe(3);
    expect(b.callsThisPage("/foo")).toBe(2);
    expect(b.callsThisPage("/bar")).toBe(1);
    expect(b.callsThisPage("/baz")).toBe(0);
  });

  it("resetPage zeroes only the named page", () => {
    const b = new AdvisorBudget();
    b.recordCall("/foo");
    b.recordCall("/foo");
    b.recordCall("/bar");
    b.resetPage("/foo");
    expect(b.callsThisPage("/foo")).toBe(0);
    expect(b.callsThisPage("/bar")).toBe(1);
    expect(b.callsThisCrawl()).toBe(3);
  });
});

describe("StallTracker", () => {
  it("starts not stalled and without invariant violation", () => {
    const s = new StallTracker();
    expect(s.consecutiveZeroNovelty()).toBe(0);
    expect(s.invariantViolationPending()).toBe(false);
  });

  it("recordZeroNovelty increments the counter", () => {
    const s = new StallTracker();
    s.recordZeroNovelty();
    s.recordZeroNovelty();
    expect(s.consecutiveZeroNovelty()).toBe(2);
  });

  it("recordNovelty resets the stall counter", () => {
    const s = new StallTracker();
    s.recordZeroNovelty();
    s.recordZeroNovelty();
    s.recordNovelty();
    expect(s.consecutiveZeroNovelty()).toBe(0);
  });

  it("recordInvariantViolation sets the flag", () => {
    const s = new StallTracker();
    s.recordInvariantViolation();
    expect(s.invariantViolationPending()).toBe(true);
  });

  it("recordAdvisorPick clears stall and invariant flag", () => {
    const s = new StallTracker();
    s.recordZeroNovelty();
    s.recordZeroNovelty();
    s.recordInvariantViolation();
    s.recordAdvisorPick();
    expect(s.consecutiveZeroNovelty()).toBe(0);
    expect(s.invariantViolationPending()).toBe(false);
  });

  it("resetForNewPage clears stall and invariant flag", () => {
    const s = new StallTracker();
    s.recordZeroNovelty();
    s.recordInvariantViolation();
    s.resetForNewPage();
    expect(s.consecutiveZeroNovelty()).toBe(0);
    expect(s.invariantViolationPending()).toBe(false);
  });
});
