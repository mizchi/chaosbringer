import { describe, expect, it } from "vitest";
import { clusterErrors } from "./clusters.js";
import { summarizePages } from "./filters.js";
import { fakePage } from "./perf-fixtures.test-helpers.js";
import { copyRequestFields, isFaultEcho, ResourceLinePairing, type ResourceOutcome, resourceLineKind } from "./resource-outcomes.js";
import type { PageError } from "./types.js";

const URL = "http://x/api";
const line = (message: string, resourceUrl = URL): PageError => ({ type: "console", message, url: "http://x/", timestamp: 0, resourceUrl });
const status500 = () => line("Failed to load resource: the server responded with a status of 500 (Internal Server Error)");
const failed = () => line("Failed to load resource: net::ERR_FAILED");
const outcome = (over: Partial<ResourceOutcome> = {}): ResourceOutcome => ({ url: URL, method: "GET", status: 500, document: false, ...over });

/** A pairing that applies the way the crawler does, without the echo bookkeeping. */
function pairing() {
  return new ResourceLinePairing((o, l) => {
    copyRequestFields(o, l);
    if (o.fault !== undefined) l.causedByFault = o.fault;
  });
}

describe("resourceLineKind", () => {
  it("reads the status a line names, a transport failure, or nothing", () => {
    expect(resourceLineKind("Failed to load resource: the server responded with a status of 404 (Not Found)")).toEqual({ status: 404 });
    expect(resourceLineKind("Failed to load resource: net::ERR_EMPTY_RESPONSE")).toEqual({ failed: true });
    expect(resourceLineKind("app: Failed to load resource")).toBeUndefined();
  });
});

describe("ResourceLinePairing", () => {
  it("pairs a line with its response whichever arrives first", () => {
    const p = pairing();
    const early = status500();
    p.outcome(outcome({ method: "POST", fault: "api-500" }));
    p.line(early);
    expect(early).toMatchObject({ status: 500, method: "POST", causedByFault: "api-500" });

    const late = status500();
    p.line(late);
    expect(late.status).toBeUndefined();
    p.outcome(outcome({ method: "PUT" }));
    expect(late).toMatchObject({ status: 500, method: "PUT" });
  });

  it("pairs by URL and kind: a status line with a response of that status, a net:: line with a failure", () => {
    const p = pairing();
    // A stylesheet that answered 503 fails as ERR_ABORTED too: two outcomes, one line.
    p.outcome(outcome({ url: "http://x/a.css", status: undefined, fault: "css" }));
    p.outcome(outcome({ url: "http://x/a.css", status: 503, fault: "css" }));
    const css = line("Failed to load resource: the server responded with a status of 503 (Service Unavailable)", "http://x/a.css");
    p.line(css);
    expect(css.status).toBe(503);
    const other = status500();
    p.line(other); // no response of this URL yet
    const abort = failed();
    p.outcome(outcome({ status: undefined, fault: "abort" }));
    p.line(abort);
    expect(abort.causedByFault).toBe("abort");
    expect(abort.status).toBeUndefined();
    expect(other.causedByFault).toBeUndefined();
  });

  it("tags as many lines as there were faulted outcomes, no more", () => {
    const p = pairing();
    const lines = [status500(), status500(), status500()];
    p.outcome(outcome({ fault: "f" }));
    p.outcome(outcome());
    p.outcome(outcome());
    for (const l of lines) p.line(l);
    expect(lines.filter(isFaultEcho)).toHaveLength(1);
    expect(lines.every((l) => l.status === 500)).toBe(true);
  });

  // copyRequestFields is the crawler's; whether an outcome is the page's
  // document is pinned end to end (http-errors.e2e.test.ts, dead links).
  it("leaves a page's own document without status or method", () => {
    const p = pairing();
    const doc = status500();
    p.outcome(outcome({ document: true }));
    p.line(doc);
    expect(doc.status).toBeUndefined();
    expect(doc.method).toBeUndefined();
  });
});

describe("a fault echo in the summary and the clusters", () => {
  it("is counted as faultEchoes and in no other count, cluster or HTTP error", () => {
    const echo: PageError = { ...status500(), status: 500, method: "GET", causedByFault: "api-500" };
    const real: PageError = { ...status500(), status: 500, method: "GET" };
    const summary = summarizePages([fakePage("http://x/", undefined, { errors: [echo] }), fakePage("http://x/b", undefined, { errors: [real] })]);
    expect(summary).toMatchObject({ consoleErrors: 1, pagesWithErrors: 1, faultEchoes: 1 });
    expect(summary.httpErrors).toEqual({ total: 1, "4xx": 0, "5xx": 1, byStatus: { "500": 1 } });
    expect(clusterErrors([echo, real]).map((c) => c.count)).toEqual([1]);
    expect(clusterErrors([echo])).toEqual([]);
  });
});
