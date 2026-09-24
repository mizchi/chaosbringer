import { beforeEach, describe, expect, it } from "vitest";
import { startSpan, withSpan } from "./trace";

const measures = () =>
  performance.getEntriesByType("measure") as PerformanceEntry[];

describe("withSpan / startSpan", () => {
  beforeEach(() => {
    performance.clearMeasures();
    performance.clearMarks();
  });

  it("emits a measure named after the span", () => {
    withSpan("sync-op", () => 42);
    expect(measures().some((m) => m.name === "sync-op")).toBe(true);
  });

  it("returns the fn result unchanged", () => {
    expect(withSpan("op", () => 42)).toBe(42);
  });

  it("emits the measure after an async fn resolves", async () => {
    const p = withSpan("async-op", () => Promise.resolve("done"));
    expect(measures().some((m) => m.name === "async-op")).toBe(false);
    await p;
    expect(measures().some((m) => m.name === "async-op")).toBe(true);
  });

  it("closes the span and rethrows when fn throws", () => {
    expect(() =>
      withSpan("throwing", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(measures().some((m) => m.name === "throwing")).toBe(true);
  });

  it("emits only one measure even if end() is called twice", () => {
    const span = startSpan("once");
    span.end();
    span.end();
    expect(measures().filter((m) => m.name === "once")).toHaveLength(1);
  });
});
