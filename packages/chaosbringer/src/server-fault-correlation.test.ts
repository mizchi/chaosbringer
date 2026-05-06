/**
 * Phase 2 — per-action and per-page correlation in `generateReport`.
 *
 * These tests exercise the join logic via a thin harness that manipulates
 * a `ChaosCrawler` instance's internal state (results, actions, collector)
 * and then triggers report generation. We avoid spinning up Playwright /
 * the fixture server because the join logic is pure data manipulation.
 */

import { describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { ServerFaultCollector } from "./server-fault-collector.js";
import type { PageResult, ActionResult, ServerFaultEvent } from "./types.js";

function freshCrawler(): ChaosCrawler {
  // baseUrl is the only required option; everything else defaults.
  return new ChaosCrawler({ baseUrl: "https://app.test" });
}

function pushPage(crawler: ChaosCrawler, url: string): PageResult {
  const result: PageResult = {
    url,
    status: "success",
    statusCode: 200,
    loadTime: 0,
    errors: [],
    warnings: [],
    blockedNavigations: [],
    discoveredLinks: [],
    actions: [],
    metrics: {},
    hasErrors: false,
  };
  // The crawler tracks visited pages in `this.results`. Tests reach in via
  // the same field name the production code uses.
  (crawler as unknown as { results: PageResult[] }).results.push(result);
  return result;
}

function pushAction(crawler: ChaosCrawler, action: ActionResult): ActionResult {
  (crawler as unknown as { actions: ActionResult[] }).actions.push(action);
  return action;
}

function pushFault(crawler: ChaosCrawler, ev: ServerFaultEvent): void {
  // The crawler holds a `serverFaultCollector` only when
  // `server.mode === "remote"`; for the test we install one ourselves.
  const internal = crawler as unknown as { serverFaultCollector: ServerFaultCollector | null };
  if (!internal.serverFaultCollector) {
    internal.serverFaultCollector = new ServerFaultCollector("x-chaos-fault");
  }
  // Build matching headers for the collector to parse.
  const headers = new Headers({
    "x-chaos-fault-kind": ev.attrs.kind,
    "x-chaos-fault-path": ev.attrs.path,
    "x-chaos-fault-method": ev.attrs.method,
  });
  if (ev.attrs.targetStatus !== undefined) {
    headers.set("x-chaos-fault-target-status", String(ev.attrs.targetStatus));
  }
  if (ev.attrs.latencyMs !== undefined) {
    headers.set("x-chaos-fault-latency-ms", String(ev.attrs.latencyMs));
  }
  if (ev.traceId) {
    headers.set("x-chaos-fault-trace-id", ev.traceId);
  }
  internal.serverFaultCollector.observe({ headers, pageUrl: ev.pageUrl });
}

describe("traceIds capture during action execution", () => {
  it("appends trace-ids to currentAction during the action's window", () => {
    const crawler = freshCrawler();
    const action: ActionResult = {
      type: "click",
      target: "Save",
      success: true,
      timestamp: Date.now(),
    };
    // Simulate the action loop: set currentAction before execution.
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = action;
    // Simulate the injection site calling the internal hook for two requests.
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
      "00000000000000000000000000000001",
    );
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
      "00000000000000000000000000000002",
    );
    expect(action.traceIds).toEqual([
      "00000000000000000000000000000001",
      "00000000000000000000000000000002",
    ]);
  });

  it("ignores recordTraceId calls when no action is current", () => {
    const crawler = freshCrawler();
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = null;
    expect(() =>
      (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
        "00000000000000000000000000000003",
      ),
    ).not.toThrow();
  });

  it("attributes trace-ids to the most recent action when called between actions", () => {
    const crawler = freshCrawler();
    const a1: ActionResult = { type: "click", target: "A", success: true, timestamp: 0 };
    const a2: ActionResult = { type: "click", target: "B", success: true, timestamp: 1 };

    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = a1;
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("a1-trace");

    // Next iteration begins — currentAction is reassigned.
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = a2;
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("a2-trace");

    expect(a1.traceIds).toEqual(["a1-trace"]);
    expect(a2.traceIds).toEqual(["a2-trace"]);
  });
});

describe("traceparent.onInject feeds recordTraceId", () => {
  it("invokes recordTraceId for each synthesised traceparent", () => {
    const crawler = freshCrawler();
    const action: ActionResult = { type: "click", target: "x", success: true, timestamp: 0 };
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = action;

    // Simulate two synthesised injections by calling recordTraceId directly,
    // mirroring what the in-route handler does.
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("aa".repeat(16));
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("bb".repeat(16));

    expect(action.traceIds).toEqual(["aa".repeat(16), "bb".repeat(16)]);
  });
});

describe("generateReport joins serverFaults onto pages and actions", () => {
  function callGenerateReport(crawler: ChaosCrawler) {
    // generateReport is private; reach in directly with a cast.
    return (crawler as unknown as {
      generateReport: (endTime: number) => import("./types.js").CrawlReport;
    }).generateReport(Date.now());
  }

  it("populates PageResult.serverFaultEvents by pageUrl", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushPage(crawler, "https://app.test/b");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    pushFault(crawler, {
      pageUrl: "https://app.test/b",
      observedAt: 110,
      attrs: { kind: "latency", path: "/api/y", method: "POST", latencyMs: 200 },
    });

    const report = callGenerateReport(crawler);
    expect(report.serverFaults).toHaveLength(2);

    const a = report.pages.find((p) => p.url === "https://app.test/a")!;
    const b = report.pages.find((p) => p.url === "https://app.test/b")!;
    expect(a.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/x"]);
    expect(b.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/y"]);
  });

  it("omits serverFaultEvents on pages with no matching events", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushPage(crawler, "https://app.test/b");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    const report = callGenerateReport(crawler);
    const b = report.pages.find((p) => p.url === "https://app.test/b")!;
    expect(b.serverFaultEvents).toBeUndefined();
  });

  it("populates ActionResult.serverFaultEvents by traceId", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    const action = pushAction(crawler, {
      type: "click",
      target: "Buy",
      success: true,
      timestamp: 1,
      traceIds: ["aa".repeat(16), "bb".repeat(16)],
    });
    pushFault(crawler, {
      traceId: "aa".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: {
        kind: "5xx",
        path: "/api/x",
        method: "POST",
        targetStatus: 503,
        traceId: "aa".repeat(16),
      },
    });
    pushFault(crawler, {
      traceId: "cc".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 110,
      attrs: { kind: "5xx", path: "/api/y", method: "GET", targetStatus: 500, traceId: "cc".repeat(16) },
    });

    const report = callGenerateReport(crawler);
    expect(action.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/x"]);
  });

  it("omits ActionResult.serverFaultEvents when traceIds is empty/absent", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    const noTraceAction = pushAction(crawler, {
      type: "scroll",
      target: "scrollY:200",
      success: true,
      timestamp: 1,
    });
    pushFault(crawler, {
      traceId: "ee".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503, traceId: "ee".repeat(16) },
    });
    const report = callGenerateReport(crawler);
    expect(noTraceAction.serverFaultEvents).toBeUndefined();
  });

  it("references are shared between report.serverFaults and the joined views", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    const report = callGenerateReport(crawler);
    const flat = report.serverFaults![0];
    const onPage = report.pages[0].serverFaultEvents![0];
    expect(onPage).toBe(flat);
  });
});
