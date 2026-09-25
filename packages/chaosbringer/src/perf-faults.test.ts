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
        faulted: { n: 3, durationMs: 420, effectiveMs: 420, blockingMs: 6, requestCount: 3 },
        clean: { n: 2, durationMs: 110, effectiveMs: 110, blockingMs: 5, requestCount: 3 },
        delta: { durationMs: 310, effectiveMs: 310, blockingMs: 1, requestCount: 0 },
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

  it("keeps spans carrying another fault off the clean side", () => {
    // Every span also carries a runtime fault (on every page, so it cannot
    // be compared and must not empty the clean side).
    const k = "/ :: load";
    const rows = buildDegradation([
      fakeSpan(k, { durationMs: 300, faults: ["a", "b", "clock-skew"] }),
      fakeSpan(k, { durationMs: 200, faults: ["b", "clock-skew"] }),
      fakeSpan(k, { durationMs: 100, faults: ["clock-skew"] }),
    ]);
    const a = rows.find((r) => r.fault === "a")!;
    expect(a.clean).toMatchObject({ n: 1, durationMs: 100 });
    const b = rows.find((r) => r.fault === "b")!;
    expect(b.faulted).toMatchObject({ n: 2, durationMs: 250 });
    expect(b.clean).toMatchObject({ n: 1, durationMs: 100 });
    expect(rows.map((r) => r.fault)).toEqual(["a", "b"]);
  });

  it("reports no pair when the only unfaulted-by-it spans carry another fault", () => {
    // E4 playground-server run: `/users/:id :: load` had two loads hit by
    // server latency and one by a 503, and no load without either. The old
    // clean side read the latency-faulted loads, so the 503 read as
    // "makes loads 300 ms faster" (delta -297.5).
    const k = "/users/:id :: load";
    const rows = buildDegradation([
      fakeSpan(k, { durationMs: 829.1, faults: ["server:latency"] }),
      fakeSpan(k, { durationMs: 531.6, faults: ["server:5xx"] }),
      fakeSpan(k, { durationMs: 829.2, faults: ["server:latency"] }),
    ]);
    expect(rows).toEqual([]);
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

  // B2 follow-up (2026-09-24 evaluation, E4 xhr-site): under networkidle the
  // Reload click closes ~5 ms after its fetch starts, so a 300 ms delay on
  // that fetch never reached durationMs and the entry read -16..-30 ms.
  it("counts the requests a span fired but did not wait for in effectiveMs", () => {
    const k = "/items/:id :: click Reload";
    const rows = buildDegradation([
      // faulted: span closed at 5 ms, its fetch answered 300 ms later
      fakeSpan(k, { durationMs: 5, requestCount: 1, settledMs: 305, faults: ["api-delay-300"] }),
      fakeSpan(k, { durationMs: 6, requestCount: 1, settledMs: 306, faults: ["api-delay-300"] }),
      fakeSpan(k, { durationMs: 7, requestCount: 1, settledMs: 8 }),
      fakeSpan(k, { durationMs: 5, requestCount: 1, settledMs: 4 }),
    ]);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r!.faulted).toMatchObject({ durationMs: 5.5, effectiveMs: 305.5 });
    expect(r!.clean).toMatchObject({ durationMs: 6, effectiveMs: 6.5 });
    expect(r!.delta.durationMs).toBe(-0.5);
    expect(r!.delta.effectiveMs).toBe(299);
  });

  it("uses durationMs as the effective duration when a span's requests finished inside it or it fired none", () => {
    const k = "/ :: load";
    const [r] = buildDegradation([
      fakeSpan(k, { durationMs: 400, settledMs: 250, faults: ["f"] }),
      fakeSpan(k, { durationMs: 100 }),
    ]);
    expect(r!.faulted.effectiveMs).toBe(400);
    expect(r!.clean.effectiveMs).toBe(100);
    expect(r!.delta.effectiveMs).toBe(300);
  });

  it("sorts by the effectiveMs delta", () => {
    const rows = buildDegradation([
      fakeSpan("/a :: load", { durationMs: 200, faults: ["f"] }),
      fakeSpan("/a :: load", { durationMs: 100 }),
      fakeSpan("/b :: click #go", { durationMs: 5, settledMs: 305, faults: ["f"] }),
      fakeSpan("/b :: click #go", { durationMs: 5, settledMs: 6 }),
    ]);
    expect(rows.map((r) => [r.key, r.delta.durationMs, r.delta.effectiveMs])).toEqual([
      ["/b :: click #go", 0, 299],
      ["/a :: load", 100, 100],
    ]);
  });

  it("is empty with no faults at all", () => {
    expect(buildDegradation([fakeSpan("/ :: load"), fakeSpan("/ :: load")])).toEqual([]);
  });
});
