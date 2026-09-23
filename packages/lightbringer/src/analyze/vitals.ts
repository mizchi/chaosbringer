// User-perceived performance analysis. Web-vitals attribution sub-parts
// (pickAttribution), per-span INP from Event Timing (buildSpanInteraction), and
// frame cadence from a rAF probe (buildSpanFrames). Pure: consumes plain records.
import { round, type EpochWindow } from "./util";

export interface VitalSample {
  value: number;
  rating: string;
  attribution: Record<string, unknown>;
}

/**
 * Responsiveness of the interactions inside a span (per-step INP). web-vitals
 * reports one page-global worst INP; this attributes the worst interaction to the
 * span it happened in and breaks it into the three INP phases, so you can see
 * which step is janky and why. Sourced from the Event Timing API
 * (interactionId > 0 entries). Undefined for spans with no interaction.
 */
export interface SpanInteraction {
  /** interactions (interactionId>0 event-timing entries) in the span */
  count: number;
  /** worst interaction's total latency (input → next paint), ms — the span's INP */
  maxDurationMs: number;
  /** event type of the worst interaction (click / keydown / pointerup / …) */
  type: string;
  /** time before the handler ran (main thread busy) */
  inputDelayMs: number;
  /** time spent in the event handlers */
  processingMs: number;
  /** time from handlers done to the next paint */
  presentationMs: number;
}

/**
 * Frame cadence during a span (animation smoothness), from a rAF probe. A static
 * span sits near display refresh with no drops; a janky pan/scroll shows dropped
 * frames and a long worst-frame. The quantity-side render metrics (paint/gpu) say
 * how much work; this says whether it actually rendered smoothly.
 */
export interface SpanFrames {
  count: number;
  /** missed display frames (each gap counts floor(gap/16.7)-1) */
  droppedFrames: number;
  /** longest gap between frames (ms) — the worst hitch */
  longestFrameMs: number;
  /** effective frames per second over the span */
  fps: number;
}

/** Event Timing entry shifted to epoch ms (interactionId>0 interactions). */
export interface EpochEvent {
  epochStart: number;
  duration: number;
  type: string;
  start: number;
  processingStart: number;
  processingEnd: number;
}

/** Keep only the attribution fields that matter per metric (drops noise). */
export function pickAttribution(
  name: string,
  attr: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!attr) return {};
  const keys: Record<string, string[]> = {
    LCP: [
      "element",
      "url",
      "timeToFirstByte",
      "resourceLoadDelay",
      "resourceLoadDuration",
      "elementRenderDelay",
    ],
    INP: [
      "interactionTarget",
      "interactionType",
      "inputDelay",
      "processingDuration",
      "presentationDelay",
    ],
    CLS: ["largestShiftTarget", "largestShiftValue"],
  };
  const wanted = keys[name];
  if (!wanted) return {};
  const out: Record<string, unknown> = {};
  for (const k of wanted) {
    if (attr[k] !== undefined) out[k] = attr[k];
  }
  return out;
}

/** Worst interaction in the span window, split into the three INP phases. */
export function buildSpanInteraction(
  span: EpochWindow,
  events: EpochEvent[],
): SpanInteraction | undefined {
  const inWindow = events.filter(
    (e) => e.epochStart >= span.startEpochMs && e.epochStart <= span.endEpochMs,
  );
  if (inWindow.length === 0) return undefined;
  let worst = inWindow[0];
  for (const e of inWindow) if (e.duration > worst.duration) worst = e;
  return {
    count: inWindow.length,
    maxDurationMs: round(worst.duration),
    type: worst.type,
    inputDelayMs: round(worst.processingStart - worst.start),
    processingMs: round(worst.processingEnd - worst.processingStart),
    presentationMs: round(worst.start + worst.duration - worst.processingEnd),
  };
}

/** Frame cadence inside the span window (16.7ms = one 60Hz frame). */
export function buildSpanFrames(
  span: EpochWindow,
  frameEpochs: number[],
): SpanFrames | undefined {
  const inWindow = frameEpochs
    .filter((t) => t >= span.startEpochMs && t <= span.endEpochMs)
    .sort((a, b) => a - b);
  if (inWindow.length < 2) return undefined;
  let dropped = 0;
  let longest = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const dt = inWindow[i] - inWindow[i - 1];
    if (dt > longest) longest = dt;
    const missed = Math.round(dt / 16.67) - 1;
    if (missed > 0) dropped += missed;
  }
  const seconds = (inWindow[inWindow.length - 1] - inWindow[0]) / 1000;
  return {
    count: inWindow.length,
    droppedFrames: dropped,
    longestFrameMs: round(longest),
    fps: seconds > 0 ? round((inWindow.length - 1) / seconds) : 0,
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

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
}
