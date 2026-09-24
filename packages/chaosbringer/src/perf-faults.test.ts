import { describe, expect, it } from "vitest";
import { fakeSpan } from "./perf-fixtures.test-helpers.js";
import {
  addSpanFaults,
  buildDegradation,
  DEGRADATION_TOP_N,
  serverFaultName,
  SpanFaultTags,
  tagServerFaults,
} from "./perf-faults.js";
import type { ServerFaultEvent } from "./types.js";

describe("SpanFaultTags", () => {
  it("tags the spans open when a fault fires, and nothing after", () => {
    const t = new SpanFaultTags<string>();
    t.begin("load");
    t.note("api-delay");
    expect(t.end("load")).toEqual(["api-delay"]);
    t.begin("click");
    expect(t.end("click")).toBeUndefined();
  });

  it("carries persistent faults into later spans and page faults into every span", () => {
    const t = new SpanFaultTags<number>(["clock-skew"]);
    t.note("cpu-throttle:4x", { persistent: true }); // before any span: beforeNavigation
    t.begin(1);
    t.note("api-500");
    t.note("api-500");
    expect(t.end(1)).toEqual(["api-500", "clock-skew", "cpu-throttle:4x"]);
    t.begin(2);
    expect(t.end(2)).toEqual(["clock-skew", "cpu-throttle:4x"]);
  });

  it("forgets a span once ended", () => {
    const t = new SpanFaultTags<string>();
    t.begin("a");
    expect(t.end("a")).toBeUndefined();
    t.note("late");
    expect(t.end("a")).toBeUndefined();
  });
});

describe("server-fault tagging", () => {
  const event = (traceId: string | undefined, kind: "5xx" | "latency"): ServerFaultEvent => ({
    ...(traceId ? { traceId } : {}),
    attrs: { kind, path: "/api", method: "GET" },
    observedAt: 0,
    pageUrl: "http://x/",
  });

  it("names a server fault by kind", () => {
    expect(serverFaultName(event("t", "5xx"))).toBe("server:5xx");
  });

  it("joins events onto spans by trace id, deduplicated and sorted", () => {
    const a = fakeSpan("/ :: click #a", { faults: ["net"] });
    const b = fakeSpan("/ :: click #b");
    const c = fakeSpan("/ :: load");
    tagServerFaults(
      [
        { span: a, traceIds: ["t1", "t2"] },
        { span: b, traceIds: ["t3"] },
        { span: c, traceIds: undefined },
      ],
      [event("t1", "latency"), event("t2", "latency"), event("t2", "5xx"), event(undefined, "5xx")],
    );
    expect(a.faults).toEqual(["net", "server:5xx", "server:latency"]);
    expect(b.faults).toBeUndefined();
    expect(c.faults).toBeUndefined();
  });

  it("addSpanFaults leaves a span without faults untouched when given none", () => {
    const s = fakeSpan("/ :: load");
    addSpanFaults(s, []);
    expect("faults" in s).toBe(false);
  });
});

describe("buildDegradation", () => {
  it("compares medians with vs without each fault, per key", () => {
    const key = "/item/:id :: load";
    const spans = [
      fakeSpan(key, { durationMs: 400, blockingMs: 5, requestCount: 3, faults: ["api-delay"] }),
      fakeSpan(key, { durationMs: 420, blockingMs: 7, requestCount: 3, faults: ["api-delay"] }),
      fakeSpan(key, { durationMs: 900, blockingMs: 6, requestCount: 5, faults: ["api-delay"] }),
      fakeSpan(key, { durationMs: 100, blockingMs: 5, requestCount: 3 }),
      fakeSpan(key, { durationMs: 120, blockingMs: 5, requestCount: 3 }),
      // only one side: nothing to compare against
      fakeSpan("/other :: load", { durationMs: 50, faults: ["api-delay"] }),
    ];
    expect(buildDegradation(spans)).toEqual([
      {
        key,
        fault: "api-delay",
        faulted: { n: 3, durationMs: 420, blockingMs: 6, requestCount: 3 },
        clean: { n: 2, durationMs: 110, blockingMs: 5, requestCount: 3 },
        delta: { durationMs: 310, blockingMs: 1, requestCount: 0 },
      },
    ]);
  });

  it("puts interactionMs in only when both sides measured one", () => {
    const k = "/ :: click #go";
    const one = buildDegradation([
      fakeSpan(k, { durationMs: 200, interactionMs: 80, faults: ["f"] }),
      fakeSpan(k, { durationMs: 100, interactionMs: 30 }),
    ]);
    expect(one[0]!.delta.interactionMs).toBe(50);
    const none = buildDegradation([
      fakeSpan(k, { durationMs: 200, interactionMs: 80, faults: ["f"] }),
      fakeSpan(k, { durationMs: 100 }),
    ]);
    expect(none[0]!.faulted.interactionMs).toBe(80);
    expect(none[0]!.clean.interactionMs).toBeUndefined();
    expect(none[0]!.delta.interactionMs).toBeUndefined();
  });

  it("treats spans with another fault as the clean side of this one", () => {
    const k = "/ :: load";
    const rows = buildDegradation([
      fakeSpan(k, { durationMs: 300, faults: ["a", "b"] }),
      fakeSpan(k, { durationMs: 200, faults: ["b"] }),
      fakeSpan(k, { durationMs: 100 }),
    ]);
    const a = rows.find((r) => r.fault === "a")!;
    expect(a.clean).toMatchObject({ n: 2, durationMs: 150 });
    const b = rows.find((r) => r.fault === "b")!;
    expect(b.faulted).toMatchObject({ n: 2, durationMs: 250 });
    expect(rows.map((r) => r.fault)).toEqual(["a", "b"]); // 150 before 150: first seen
  });

  it("keeps the top 10 by durationMs delta, largest first, negatives last", () => {
    const spans = Array.from({ length: 12 }, (_, i) => [
      fakeSpan(`/p${i} :: load`, { durationMs: 100 + i * 10 - 20, faults: ["f"] }),
      fakeSpan(`/p${i} :: load`, { durationMs: 100 }),
    ]).flat();
    const rows = buildDegradation(spans);
    expect(rows).toHaveLength(DEGRADATION_TOP_N);
    expect(rows[0]!.key).toBe("/p11 :: load");
    expect(rows[0]!.delta.durationMs).toBe(90);
    expect(rows.at(-1)!.delta.durationMs).toBe(0);
    expect(buildDegradation(spans, 20).at(-1)!.delta.durationMs).toBe(-20);
  });

  it("is empty with no faults at all", () => {
    expect(buildDegradation([fakeSpan("/ :: load"), fakeSpan("/ :: load")])).toEqual([]);
  });
});
