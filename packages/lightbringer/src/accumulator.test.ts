import { describe, expect, it } from "vitest";
import { PerfAccumulator, accumulateSnapshot } from "./accumulator";
import type { DrainPayload } from "./browser";
import { buildReport, buildSpanReport, firstPartyDomainOf } from "./report";
import type { RawSpan } from "./controller";

const payload = (over: Partial<DrainPayload> = {}): DrainPayload => ({
  timeOrigin: 1_000_000,
  url: "http://x.test/a",
  vitals: {},
  longTasks: [],
  loaf: [],
  measures: [],
  events: [],
  frames: [],
  ...over,
});

const vital = (name: string, value: number) => ({ name, value, rating: "good", attribution: {} });

const span = (name: string, start: number, end: number): RawSpan => ({
  name,
  startEpochMs: start,
  endEpochMs: end,
  capped: false,
  render: {
    recalcStyleCount: 0,
    recalcStyleMs: 0,
    layoutCount: 0,
    layoutMs: 0,
    nodes: 0,
    scriptMs: 0,
  },
  memory: {
    jsHeapUsedMB: 0,
    jsHeapDeltaMB: 0,
    arrayBuffers: 0,
    domNodes: 0,
    jsEventListeners: 0,
    listenersDelta: 0,
    documentsDelta: 0,
  },
  traceStartUs: 0,
  traceEndUs: 0,
});

describe("PerfAccumulator", () => {
  it("shifts every entry to epoch ms with its own document's timeOrigin", () => {
    const acc = new PerfAccumulator();
    acc.add(
      payload({
        longTasks: [{ start: 10, duration: 120 }],
        loaf: [{ start: 11, duration: 130, blocking: 70 }],
        measures: [{ name: "m", start: 5, duration: 2, detail: { __lbSpan: true } }],
        events: [{ start: 20, duration: 40, type: "click", processingStart: 25, processingEnd: 30 }],
        frames: [1, 17],
      }),
    );
    acc.add(payload({ timeOrigin: 2_000_000, url: "http://x.test/b", longTasks: [{ start: 3, duration: 60 }] }));
    expect(acc.longTasks).toEqual([
      { epochStart: 1_000_010, duration: 120 },
      { epochStart: 2_000_003, duration: 60 },
    ]);
    expect(acc.loaf).toEqual([{ epochStart: 1_000_011, duration: 130, blocking: 70 }]);
    expect(acc.measures[0].startTime).toBe(1_000_005);
    expect(acc.events[0]).toMatchObject({ epochStart: 1_000_020, start: 20, processingStart: 25 });
    expect(acc.frames).toEqual([1_000_001, 1_000_017]);
    expect(acc.documents.map((d) => d.url)).toEqual(["http://x.test/a", "http://x.test/b"]);
  });

  it("ignores the initial about:blank document when it holds only frames", () => {
    const acc = new PerfAccumulator();
    acc.add(payload({ timeOrigin: 900_000, url: "about:blank", frames: [1, 17] }));
    expect(acc.sawDocument).toBe(false);
    expect(acc.frames).toEqual([]);
    acc.add(payload({ timeOrigin: 900_000, url: "about:blank", longTasks: [{ start: 1, duration: 60 }] }));
    expect(acc.documents.map((d) => d.url)).toEqual(["about:blank"]);
  });

  it("flags a document whose performance.now was patched before the collector", () => {
    const acc = new PerfAccumulator();
    acc.add(payload());
    expect(acc.clockPatched).toBe(false);
    acc.add(payload({ clockPatched: true }));
    expect(acc.clockPatched).toBe(true);
  });

  it("keeps vitals per document, last-write-wins per metric", () => {
    const acc = new PerfAccumulator();
    acc.add(payload({ vitals: { LCP: vital("LCP", 100), CLS: vital("CLS", 0) } }));
    acc.add(payload({ vitals: { LCP: vital("LCP", 250) } }));
    expect(acc.documents).toHaveLength(1);
    expect(acc.documents[0].vitals.LCP.value).toBe(250);
    expect(acc.documents[0].vitals.CLS.value).toBe(0);
  });

  it("orders documents by timeOrigin even when a pagehide emit arrives late", () => {
    const acc = new PerfAccumulator();
    acc.add(payload({ timeOrigin: 3000, url: "c" }));
    acc.add(payload({ timeOrigin: 1000, url: "a" }));
    acc.add(payload({ timeOrigin: 2000, url: "b" }));
    expect(acc.documents.map((d) => d.url)).toEqual(["a", "b", "c"]);
    expect(acc.lastDocument()?.url).toBe("c");
  });

  it("filters frames by the retention policy and trims the idle tail", () => {
    let from = Infinity;
    const acc = new PerfAccumulator({ keepFramesFrom: () => from });
    acc.add(payload({ timeOrigin: 0, frames: [1, 2, 3] }));
    expect(acc.frames).toEqual([]);
    from = 2;
    acc.add(payload({ timeOrigin: 0, frames: [1, 2, 3, 4] }));
    expect(acc.frames).toEqual([2, 3, 4]);
    acc.dropFramesAfter(3);
    expect(acc.frames).toEqual([2, 3]);
  });

  it("ignores empty / malformed payloads and tracks sawDocument", () => {
    const acc = new PerfAccumulator();
    acc.add(null);
    acc.add(undefined);
    acc.add({} as DrainPayload);
    expect(acc.sawDocument).toBe(false);
    acc.add({ timeOrigin: 5, url: "u" } as DrainPayload);
    expect(acc.sawDocument).toBe(true);
  });
});

describe("buildReport from accumulated entries", () => {
  it("attributes a pre-navigation long task to its span and lists documents", () => {
    const acc = new PerfAccumulator();
    acc.add(
      payload({
        timeOrigin: 1_000_000,
        vitals: { TTFB: vital("TTFB", 5) },
        longTasks: [{ start: 100, duration: 120 }],
      }),
    );
    acc.add(payload({ timeOrigin: 1_000_500, url: "http://x.test/b", vitals: { TTFB: vital("TTFB", 9) } }));
    const r = buildReport("t", "http://x.test/b", acc, [span("a", 1_000_050, 1_000_300), span("b", 1_000_600, 1_000_700)], []);
    expect(r.spans[0].cpu).toMatchObject({ longTaskCount: 1, blockingMs: 120 });
    expect(r.spans[1].cpu.longTaskCount).toBe(0);
    expect(r.vitals.TTFB.value).toBe(9);
    expect(r.documents?.map((d) => d.url)).toEqual(["http://x.test/a", "http://x.test/b"]);
  });

  it("counts the documents a span navigated to, from their timeOrigin, whatever memory reads", () => {
    // Under memGc the forced GC collects the old document before the end
    // reading, so `memory.documentsDelta` reads 0 on a navigation. The new
    // document's timeOrigin still falls inside the span.
    const acc = new PerfAccumulator();
    acc.add(payload({ timeOrigin: 1_000_000 }));
    acc.add(payload({ timeOrigin: 1_000_500, url: "http://x.test/b" }));
    acc.add(payload({ timeOrigin: 1_000_900, url: "http://x.test/c" }));
    const r = buildReport(
      "t",
      "http://x.test/c",
      acc,
      [span("load", 999_990, 1_000_100), span("stay", 1_000_200, 1_000_400), span("nav2", 1_000_450, 1_001_000)],
      [],
    );
    expect(r.spans.map((s) => s.memory.documentsDelta)).toEqual([0, 0, 0]);
    expect(r.spans[0].navigations).toBe(1);
    // absent, not 0, on a span that stayed on its document
    expect(r.spans[1]).not.toHaveProperty("navigations");
    expect(r.spans[2].navigations).toBe(2);
  });

  it("omits documents for a single document and matches the legacy snapshot form", () => {
    const raw = {
      vitals: { LCP: vital("LCP", 42) },
      longTasks: [{ start: 100, duration: 80 }],
      loaf: [],
      measures: [
        { name: "outer", start: 10, duration: 100, detail: { __lbSpan: true, attributes: { k: 1 } } },
        { name: "inner", start: 20, duration: 10, detail: { __lbSpan: true, attributes: {} } },
      ],
      events: [],
      frames: [],
    };
    const spans = [span("s", 1_000_000, 1_000_300)];
    const legacy = buildReport("t", "http://x.test/", raw, 1_000_000, spans, []);
    const viaAcc = buildReport("t", "http://x.test/", accumulateSnapshot(raw, 1_000_000), spans, []);
    expect(viaAcc).toEqual(legacy);
    expect(legacy.documents).toBeUndefined();
    expect(legacy.appSpans.map((s) => [s.name, s.startUnixMs, s.parentSpanId])).toEqual([
      ["outer", 1_000_010, undefined],
      ["inner", 1_000_020, "s0"],
    ]);
    expect(legacy.appSpans[0].attributes).toEqual({ k: 1 });
    expect(legacy.spans[0].cpu.blockingMs).toBe(80);
  });
});

describe("buildSpanReport", () => {
  it("is what buildReport reports for the same span, so a mid-run peek agrees with the report", () => {
    const acc = new PerfAccumulator();
    acc.add(
      payload({
        longTasks: [{ start: 100, duration: 120 }],
        events: [{ start: 110, duration: 90, type: "click", processingStart: 115, processingEnd: 190 }],
      }),
    );
    const reqs = [
      { url: "http://x.test/api", type: "Fetch", startMono: 0, startEpochMs: 1_000_120, endEpochMs: 1_000_180, encoded: 2048 },
    ];
    const spans = [span("a", 1_000_050, 1_000_300)];
    const report = buildReport("t", "http://x.test/a", acc, spans, reqs);
    const peek = buildSpanReport(spans[0], acc, reqs, firstPartyDomainOf("http://x.test/a"));
    expect(peek).toEqual(report.spans[0]);
    expect(peek.cpu.blockingMs).toBe(120);
    expect(peek.network.requestCount).toBe(1);
    expect(peek.interaction?.maxDurationMs).toBe(90);
  });
});
