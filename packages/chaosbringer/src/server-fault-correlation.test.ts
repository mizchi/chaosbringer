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
