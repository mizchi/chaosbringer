import { describe, expect, it } from "vitest";
import { emptyLatencyStats, latencyStats, parseDurationMs, quantile } from "./histogram.js";

describe("quantile", () => {
  it("returns 0 for empty array", () => {
    expect(quantile([], 0.5)).toBe(0);
  });

  it("matches numpy linear interpolation", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(quantile(arr, 0)).toBe(1);
    expect(quantile(arr, 1)).toBe(5);
    expect(quantile(arr, 0.5)).toBe(3);
    expect(quantile(arr, 0.25)).toBe(2);
    expect(quantile(arr, 0.75)).toBe(4);
  });

  it("clamps out-of-range q values", () => {
    const arr = [10, 20, 30];
    expect(quantile(arr, -0.1)).toBe(10);
    expect(quantile(arr, 1.5)).toBe(30);
  });
});

describe("latencyStats", () => {
  it("returns zeros for empty input", () => {
    const s = latencyStats([]);
    expect(s).toEqual(emptyLatencyStats());
    expect(s.count).toBe(0);
  });

  it("computes mean + p50/p95/p99 + min/max", () => {
    const samples = [];
    for (let i = 1; i <= 100; i++) samples.push(i);
    const s = latencyStats(samples);
    expect(s.count).toBe(100);
    expect(s.meanMs).toBeCloseTo(50.5);
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(100);
    expect(s.p50Ms).toBeCloseTo(50.5, 0);
    expect(s.p95Ms).toBeGreaterThan(94);
    expect(s.p95Ms).toBeLessThan(96);
    expect(s.p99Ms).toBeGreaterThan(98);
  });

  it("handles a single sample", () => {
    const s = latencyStats([42]);
    expect(s.count).toBe(1);
    expect(s.minMs).toBe(42);
    expect(s.maxMs).toBe(42);
    expect(s.p50Ms).toBe(42);
    expect(s.p95Ms).toBe(42);
    expect(s.p99Ms).toBe(42);
  });

  it("does not mutate the input array", () => {
    const samples = [3, 1, 2];
    latencyStats(samples);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe("parseDurationMs", () => {
  it("returns numeric input unchanged", () => {
    expect(parseDurationMs(500)).toBe(500);
  });

  it("parses ms suffix", () => {
    expect(parseDurationMs("500ms")).toBe(500);
  });

  it("parses s suffix as seconds", () => {
    expect(parseDurationMs("3s")).toBe(3000);
  });

  it("parses m suffix as minutes", () => {
    expect(parseDurationMs("2m")).toBe(120_000);
  });

  it("tolerates whitespace and fractional values", () => {
    expect(parseDurationMs("  1.5s  ")).toBe(1500);
  });

  it("treats bare numbers as ms (string form)", () => {
    expect(parseDurationMs("250")).toBe(250);
  });

  it("rejects bad input", () => {
    expect(() => parseDurationMs("forever")).toThrow();
    expect(() => parseDurationMs(-1)).toThrow();
    expect(() => parseDurationMs("3h")).toThrow();
  });
});
