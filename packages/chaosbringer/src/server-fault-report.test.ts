import { describe, expect, it } from "vitest";
import { ServerFaultCollector } from "./server-fault-collector.js";

describe("server-fault report integration", () => {
  it("collector.drain() produces the shape CrawlReport.serverFaults expects", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({
      headers: new Headers({
        "x-chaos-fault-kind": "5xx",
        "x-chaos-fault-path": "/api/x",
        "x-chaos-fault-method": "GET",
        "x-chaos-fault-target-status": "503",
        "x-chaos-fault-trace-id": "abcdef0123456789abcdef0123456789",
      }),
      pageUrl: "https://app/x",
    });
    const drained = c.drain();
    // Shape contract that CrawlReport.serverFaults exposes:
    expect(drained[0]).toMatchObject({
      traceId: "abcdef0123456789abcdef0123456789",
      pageUrl: "https://app/x",
      attrs: {
        kind: "5xx",
        path: "/api/x",
        method: "GET",
        targetStatus: 503,
        traceId: "abcdef0123456789abcdef0123456789",
      },
    });
    expect(typeof drained[0].observedAt).toBe("number");
  });
});
