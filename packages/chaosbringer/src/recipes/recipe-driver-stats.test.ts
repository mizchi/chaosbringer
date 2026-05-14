/**
 * Tests for the pure stats aggregator (issue #92). The end-to-end
 * stats accumulation through recipeDriver / recipeStoreScenario is
 * covered by the existing E2E suites + a new tweak below.
 */
import { describe, expect, it } from "vitest";
import { aggregateFirings } from "./recipe-driver.js";

describe("aggregateFirings", () => {
  it("returns [] for an empty input", () => {
    expect(aggregateFirings([])).toEqual([]);
  });

  it("groups by recipe name", () => {
    const out = aggregateFirings([
      { name: "a", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "b", succeeded: true, durationMs: 200, timestamp: 2 },
      { name: "a", succeeded: true, durationMs: 110, timestamp: 3 },
    ]);
    expect(out.map((r) => r.name).sort()).toEqual(["a", "b"]);
    const a = out.find((r) => r.name === "a")!;
    expect(a.fired).toBe(2);
    expect(a.succeeded).toBe(2);
    expect(a.failed).toBe(0);
    expect(a.avgDurationMs).toBe(105);
  });

  it("computes avgDurationMs from successful runs only", () => {
    const out = aggregateFirings([
      { name: "x", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "x", succeeded: false, durationMs: 999, timestamp: 2 },
      { name: "x", succeeded: true, durationMs: 200, timestamp: 3 },
    ]);
    expect(out[0]!.avgDurationMs).toBe(150);
  });

  it("avgDurationMs is 0 when no successful run exists", () => {
    const out = aggregateFirings([
      { name: "x", succeeded: false, durationMs: 100, timestamp: 1 },
    ]);
    expect(out[0]!.avgDurationMs).toBe(0);
    expect(out[0]!.failed).toBe(1);
  });

  it("preserves first/last timestamps", () => {
    const out = aggregateFirings([
      { name: "x", succeeded: true, durationMs: 100, timestamp: 1000 },
      { name: "x", succeeded: true, durationMs: 100, timestamp: 5000 },
      { name: "x", succeeded: true, durationMs: 100, timestamp: 3000 },
    ]);
    expect(out[0]!.firstFiredAt).toBe(1000);
    expect(out[0]!.lastFiredAt).toBe(5000);
  });

  it("sorts most-fired first, then alphabetically as tie-breaker", () => {
    const out = aggregateFirings([
      { name: "rare", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "common", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "common", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "common", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "alsoTwo", succeeded: true, durationMs: 100, timestamp: 1 },
      { name: "alsoTwo", succeeded: true, durationMs: 100, timestamp: 1 },
    ]);
    expect(out.map((r) => r.name)).toEqual(["common", "alsoTwo", "rare"]);
  });
});
