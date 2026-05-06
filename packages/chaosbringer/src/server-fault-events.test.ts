import { describe, expect, it } from "vitest";
import { parseServerFaultHeaders } from "./server-fault-events.js";

const make = (entries: Record<string, string>) => {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
};

describe("parseServerFaultHeaders", () => {
  it("returns null when the prefix marker is absent", () => {
    const h = make({ "content-type": "application/json" });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("parses a 5xx event with all headers present", () => {
    const h = make({
      "x-chaos-fault-kind": "5xx",
      "x-chaos-fault-path": "/api/todos",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-target-status": "503",
      "x-chaos-fault-trace-id": "0af7651916cd43dd8448eb211c80319c",
    });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toEqual({
      attrs: {
        kind: "5xx",
        path: "/api/todos",
        method: "GET",
        targetStatus: 503,
        traceId: "0af7651916cd43dd8448eb211c80319c",
      },
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
  });

  it("parses a latency event without target-status", () => {
    const h = make({
      "x-chaos-fault-kind": "latency",
      "x-chaos-fault-path": "/api/x",
      "x-chaos-fault-method": "POST",
      "x-chaos-fault-latency-ms": "350",
    });
    const r = parseServerFaultHeaders(h, "x-chaos-fault");
    expect(r?.attrs).toEqual({
      kind: "latency",
      path: "/api/x",
      method: "POST",
      latencyMs: 350,
    });
    expect(r?.traceId).toBeUndefined();
  });

  it("returns null for unknown kind", () => {
    const h = make({
      "x-chaos-fault-kind": "abort",
      "x-chaos-fault-path": "/x",
      "x-chaos-fault-method": "GET",
    });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("honours custom prefix", () => {
    const h = make({
      "x-my-fault-kind": "5xx",
      "x-my-fault-path": "/api",
      "x-my-fault-method": "GET",
      "x-my-fault-target-status": "500",
    });
    expect(parseServerFaultHeaders(h, "x-my-fault")?.attrs.kind).toBe("5xx");
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("ignores numeric headers that fail to parse", () => {
    const h = make({
      "x-chaos-fault-kind": "latency",
      "x-chaos-fault-path": "/api",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-latency-ms": "not-a-number",
    });
    const r = parseServerFaultHeaders(h, "x-chaos-fault");
    // Latency event still parses; the bad number is dropped (no latencyMs).
    expect(r?.attrs.kind).toBe("latency");
    expect(r?.attrs.latencyMs).toBeUndefined();
  });
});
