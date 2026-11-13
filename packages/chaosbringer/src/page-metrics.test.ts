import { describe, expect, it } from "vitest";
import { latePaintChanges, paintCheckNeeded, withLatePaint, type LoadMetricsRead, type LoadPaintHint } from "./page-metrics.js";

const ORIGIN = 1_700_000_000_000;

function hint(over: Partial<LoadPaintHint> = {}): LoadPaintHint {
  return {
    timeOrigin: ORIGIN,
    visible: true,
    collector: true,
    webVitals: true,
    hiddenEntry: false,
    fcpVital: true,
    lateImages: 0,
    input: false,
    ...over,
  };
}

function read(over: Partial<LoadMetricsRead> = {}): LoadMetricsRead {
  return {
    metrics: { ttfb: 5, fcp: 40, lcp: 40, tbt: 0, domContentLoaded: 300, load: 600 },
    longTasks: [],
    paint: hint(),
    ...over,
  };
}

describe("paintCheckNeeded", () => {
  it("skips a normal load: FCP read and delivered, no image later than the LCP candidate", () => {
    expect(paintCheckNeeded(read())).toBe(false);
  });

  it("checks when FCP is absent, with or without the collector", () => {
    expect(paintCheckNeeded(read({ metrics: { ttfb: 5 } }))).toBe(true);
    expect(paintCheckNeeded(read({ metrics: { ttfb: 5 }, longTasks: null, paint: hint({ collector: false }) }))).toBe(true);
  });

  it("checks when the FCP vital is not delivered yet", () => {
    expect(paintCheckNeeded(read({ paint: hint({ fcpVital: false }) }))).toBe(true);
  });

  it("checks for an image later than the LCP candidate, but not after an input", () => {
    expect(paintCheckNeeded(read({ paint: hint({ lateImages: 1 }) }))).toBe(true);
    // Chromium reports no LCP candidate after the first input.
    expect(paintCheckNeeded(read({ paint: hint({ lateImages: 1, input: true }) }))).toBe(false);
  });

  it("does not wait for vitals a page cannot report", () => {
    // No collector, no web-vitals, or a document that was hidden.
    expect(paintCheckNeeded(read({ paint: hint({ collector: false, fcpVital: false, lateImages: 2 }) }))).toBe(false);
    expect(paintCheckNeeded(read({ paint: hint({ webVitals: false, fcpVital: false }) }))).toBe(false);
    expect(paintCheckNeeded(read({ paint: hint({ hiddenEntry: true, fcpVital: false, lateImages: 1 }) }))).toBe(false);
  });

  it("skips a hidden document, even with FCP absent", () => {
    expect(paintCheckNeeded(read({ metrics: {}, paint: hint({ visible: false }) }))).toBe(false);
  });

  it("skips a failed read: nothing found later could be merged into it", () => {
    expect(paintCheckNeeded({ metrics: {}, longTasks: null, paint: null })).toBe(false);
  });
});

describe("withLatePaint", () => {
  it("takes a late FCP and recomputes TBT from the first read's long tasks", () => {
    const first = read({
      metrics: { ttfb: 5, lcp: 30, tbt: 230 },
      longTasks: [
        { start: 10, duration: 120 },
        { start: 200, duration: 200 },
      ],
    });
    // Without FCP, TBT counted from 0: 70 + 150. From FCP=100 only the second.
    expect(withLatePaint(first, { fcp: 100, lcp: 30, timeOrigin: ORIGIN })).toEqual({ ttfb: 5, fcp: 100, lcp: 30, tbt: 150 });
  });

  it("takes a late LCP and leaves TBT alone when FCP did not change", () => {
    const first = read({ metrics: { fcp: 24, lcp: 24, tbt: 70 }, longTasks: [{ start: 0, duration: 400 }] });
    expect(withLatePaint(first, { fcp: 24, lcp: 1044, timeOrigin: ORIGIN })).toEqual({ fcp: 24, lcp: 1044, tbt: 70 });
  });

  it("never lets an absent late value overwrite one the first read had", () => {
    const first = read({ metrics: { fcp: 24, lcp: 24, tbt: 0 } });
    expect(withLatePaint(first, { fcp: null, lcp: null, timeOrigin: ORIGIN })).toEqual({ fcp: 24, lcp: 24, tbt: 0 });
  });

  it("keeps the first read when the late one is another document's, or unread", () => {
    const first = read({ metrics: { lcp: 24 } });
    expect(withLatePaint(first, { fcp: 50, lcp: 900, timeOrigin: ORIGIN + 1 })).toEqual({ lcp: 24 });
    expect(withLatePaint(first, { fcp: 50, lcp: 900, timeOrigin: null })).toEqual({ lcp: 24 });
    expect(withLatePaint({ ...first, paint: null }, { fcp: 50, lcp: 900, timeOrigin: ORIGIN })).toEqual({ lcp: 24 });
  });

  it("does not invent a TBT without the collector", () => {
    const first = read({ metrics: { ttfb: 5 }, longTasks: null, paint: hint({ collector: false }) });
    expect(withLatePaint(first, { fcp: 80, lcp: null, timeOrigin: ORIGIN })).toEqual({ ttfb: 5, fcp: 80 });
  });
});

describe("latePaintChanges", () => {
  it("names each of FCP / LCP / TBT that changed, as [first, final]", () => {
    expect(latePaintChanges({ fcp: undefined, lcp: 30, tbt: 220 }, { fcp: 100, lcp: 30, tbt: 150 })).toEqual({
      fcp: [null, 100],
      tbt: [220, 150],
    });
  });

  it("is null when nothing changed", () => {
    expect(latePaintChanges({ fcp: 24, lcp: 24 }, { fcp: 24, lcp: 24 })).toBeNull();
  });
});
