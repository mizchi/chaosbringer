import { describe, expect, it } from "vitest";
import { decideTrigger, defaultTriggerPolicy, type TriggerPolicy, type TriggerState } from "./trigger.js";

const baseState = (): TriggerState => ({
  callsThisCrawl: 0,
  callsThisPage: 0,
  consecutiveZeroNovelty: 0,
  pendingInvariantViolation: false,
});

const policy = (overrides: Partial<TriggerPolicy> = {}): TriggerPolicy => ({
  ...defaultTriggerPolicy(),
  ...overrides,
});

describe("decideTrigger", () => {
  it("does not consult below the novelty stall threshold", () => {
    const decision = decideTrigger(
      { ...baseState(), consecutiveZeroNovelty: 4 },
      policy({ noveltyStallThreshold: 5 }),
      10,
    );
    expect(decision.consult).toBe(false);
    expect(decision.skipReason).toBe("not_stalled");
  });

  it("consults when novelty stall threshold reached", () => {
    const decision = decideTrigger(
      { ...baseState(), consecutiveZeroNovelty: 5 },
      policy({ noveltyStallThreshold: 5 }),
      10,
    );
    expect(decision.consult).toBe(true);
    expect(decision.reason).toBe("novelty_stall");
  });

  it("consults on invariant violation regardless of novelty", () => {
    const decision = decideTrigger(
      { ...baseState(), pendingInvariantViolation: true },
      policy({ noveltyStallThreshold: 999, consultOnInvariantViolation: true }),
      10,
    );
    expect(decision.consult).toBe(true);
    expect(decision.reason).toBe("invariant_violation");
  });

  it("skips invariant violation when consultOnInvariantViolation is false", () => {
    const decision = decideTrigger(
      { ...baseState(), pendingInvariantViolation: true },
      policy({ noveltyStallThreshold: 999, consultOnInvariantViolation: false }),
      10,
    );
    expect(decision.consult).toBe(false);
  });

  it("rejects when per-crawl budget exhausted", () => {
    const decision = decideTrigger(
      { ...baseState(), consecutiveZeroNovelty: 99, callsThisCrawl: 20 },
      policy({ maxCallsPerCrawl: 20 }),
      10,
    );
    expect(decision.consult).toBe(false);
    expect(decision.skipReason).toBe("budget_crawl");
  });

  it("rejects when per-page budget exhausted", () => {
    const decision = decideTrigger(
      { ...baseState(), consecutiveZeroNovelty: 99, callsThisPage: 3 },
      policy({ maxCallsPerPage: 3 }),
      10,
    );
    expect(decision.consult).toBe(false);
    expect(decision.skipReason).toBe("budget_page");
  });

  it("rejects when candidates are below the minimum", () => {
    const decision = decideTrigger(
      { ...baseState(), consecutiveZeroNovelty: 99 },
      policy({ minCandidatesToConsult: 3 }),
      2,
    );
    expect(decision.consult).toBe(false);
    expect(decision.skipReason).toBe("few_candidates");
  });

  it("budget rejection takes priority over not-stalled", () => {
    const decision = decideTrigger(
      { ...baseState(), callsThisCrawl: 20 },
      policy({ maxCallsPerCrawl: 20, noveltyStallThreshold: 5 }),
      10,
    );
    expect(decision.skipReason).toBe("budget_crawl");
  });
});

describe("defaultTriggerPolicy", () => {
  it("matches the design doc defaults", () => {
    const p = defaultTriggerPolicy();
    expect(p.maxCallsPerCrawl).toBe(20);
    expect(p.maxCallsPerPage).toBe(3);
    expect(p.noveltyStallThreshold).toBe(5);
    expect(p.consultOnInvariantViolation).toBe(true);
    expect(p.minCandidatesToConsult).toBe(3);
  });
});
