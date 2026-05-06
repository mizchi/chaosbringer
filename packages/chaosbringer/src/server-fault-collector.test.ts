import { describe, expect, it } from "vitest";
import { ServerFaultCollector } from "./server-fault-collector.js";

describe("ServerFaultCollector", () => {
  it("records 5xx events with pageUrl and observedAt", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    const headers = new Headers({
      "x-chaos-fault-kind": "5xx",
      "x-chaos-fault-path": "/api/todos",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-target-status": "503",
      "x-chaos-fault-trace-id": "0af7651916cd43dd8448eb211c80319c",
    });
    c.observe({ headers, pageUrl: "https://app/todos" });
    const events = c.drain();
    expect(events).toHaveLength(1);
    expect(events[0].pageUrl).toBe("https://app/todos");
    expect(events[0].traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(events[0].attrs.kind).toBe("5xx");
    expect(typeof events[0].observedAt).toBe("number");
  });

  it("ignores responses without the prefix", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({ headers: new Headers({ "x-other": "1" }), pageUrl: "https://app" });
    expect(c.drain()).toHaveLength(0);
  });

  it("preserves event order across pages", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    const headers = (kind: string, path: string) =>
      new Headers({
        "x-chaos-fault-kind": kind,
        "x-chaos-fault-path": path,
        "x-chaos-fault-method": "GET",
      });
    c.observe({ headers: headers("5xx", "/a"), pageUrl: "https://app/a" });
    c.observe({ headers: headers("latency", "/b"), pageUrl: "https://app/b" });
    const events = c.drain();
    expect(events.map((e) => e.attrs.path)).toEqual(["/a", "/b"]);
  });

  it("drain() empties the buffer", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({
      headers: new Headers({
        "x-chaos-fault-kind": "5xx",
        "x-chaos-fault-path": "/x",
        "x-chaos-fault-method": "GET",
      }),
      pageUrl: "https://app",
    });
    expect(c.drain()).toHaveLength(1);
    expect(c.drain()).toHaveLength(0);
  });
});
