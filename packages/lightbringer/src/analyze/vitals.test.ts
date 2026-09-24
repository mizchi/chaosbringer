import { describe, expect, it } from "vitest";
import { buildSpanFrames, buildSpanInteraction, pickAttribution } from "./vitals";

describe("pickAttribution", () => {
  it("keeps only the LCP sub-parts", () => {
    const out = pickAttribution("LCP", {
      timeToFirstByte: 100,
      elementRenderDelay: 20,
      unrelated: 1,
    });
    expect(out).toEqual({ timeToFirstByte: 100, elementRenderDelay: 20 });
  });
  it("returns empty for an unknown metric", () => {
    expect(pickAttribution("FCP", { x: 1 })).toEqual({});
  });
});

describe("buildSpanInteraction", () => {
  const span = { startEpochMs: 1000, endEpochMs: 2000 };
  it("splits the worst interaction into input / processing / presentation", () => {
    const it1 = buildSpanInteraction(span, [
      { epochStart: 1100, duration: 80, type: "click", start: 100, processingStart: 110, processingEnd: 150 },
    ]);
    expect(it1?.type).toBe("click");
    expect(it1?.inputDelayMs).toBe(10);
    expect(it1?.processingMs).toBe(40);
    expect(it1?.presentationMs).toBe(30);
  });
  it("returns undefined when no interaction falls in the window", () => {
    expect(buildSpanInteraction(span, [])).toBeUndefined();
  });
});

describe("buildSpanFrames", () => {
  it("counts dropped frames from gaps larger than one refresh", () => {
    // 1000, 1016.7 (ok), then a 50ms hitch to 1066.7 (≈2 missed frames)
    const f = buildSpanFrames({ startEpochMs: 1000, endEpochMs: 2000 }, [1000, 1016.7, 1066.7]);
    expect(f?.droppedFrames).toBe(2);
    expect(f?.longestFrameMs).toBe(50);
  });
  it("returns undefined with fewer than two frames", () => {
    expect(buildSpanFrames({ startEpochMs: 1000, endEpochMs: 2000 }, [1000])).toBeUndefined();
  });
});
