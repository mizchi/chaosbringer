import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { ddmin, minimizeActions, reportMatches, traceWithActions } from "./minimize.js";
import {
  TRACE_FORMAT_VERSION,
  type TraceAction,
  type TraceEntry,
  type TraceMeta,
} from "./trace.js";
import type { CrawlReport, PageError } from "./types.js";

const META: TraceMeta = {
  kind: "meta",
  v: TRACE_FORMAT_VERSION,
  seed: 1,
  baseUrl: "http://x/",
  startTime: 0,
};

function action(i: number, type: TraceAction["type"] = "click"): TraceAction {
  return {
    kind: "action",
    url: "http://x/",
    type,
    selector: `a#${i}`,
    success: true,
  };
}

describe("ddmin", () => {
  it("narrows down to the 1-minimal set for a simple conjunction predicate", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const required = new Set([3, 7]);
    const predicate = async (subset: number[]) =>
      Array.from(required).every((r) => subset.includes(r));
    const out = await ddmin(items, predicate);
    expect(out.sort((a, b) => a - b)).toEqual([3, 7]);
  });

  it("preserves the original order of items it keeps", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const required = new Set(["b", "d"]);
    const predicate = async (s: string[]) =>
      Array.from(required).every((r) => s.includes(r));
    const out = await ddmin(items, predicate);
    expect(out).toEqual(["b", "d"]);
  });

  it("returns a single item when only one is required", async () => {
    const predicate = async (s: number[]) => s.includes(42);
    const out = await ddmin([1, 2, 42, 3, 4], predicate);
    expect(out).toEqual([42]);
  });

  it("is stable on an empty input (no predicate calls)", async () => {
    let calls = 0;
    const predicate = async () => {
      calls++;
      return true;
    };
    const out = await ddmin<number>([], predicate);
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("invokes onStep for each successful reduction", async () => {
    const steps: Array<{ size: number; keptAfter: number }> = [];
    const predicate = async (s: number[]) => s.includes(5);
    await ddmin([1, 2, 3, 4, 5, 6, 7, 8], predicate, (info) =>
      steps.push({ size: info.size, keptAfter: info.keptAfter })
    );
    expect(steps.length).toBeGreaterThan(0);
    // Each step must shrink monotonically.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.keptAfter).toBeLessThanOrEqual(steps[i - 1]!.keptAfter);
    }
  });
});

describe("minimizeActions", () => {
  it("says the failure did not reproduce, and keeps every item, when the full set does not match", async () => {
    // ddmin used to run anyway: a never-matching --match kept all 8 actions
    // over 28 replays and printed "Reduced 8 → 8".
    const calls: number[][] = [];
    const out = await minimizeActions([1, 2, 3, 4, 5, 6, 7, 8], async (s) => {
      calls.push(s);
      return false;
    });
    expect(out).toEqual({ reproduced: false, minimized: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(calls).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
  });

  it("returns no items when the failure reproduces without any", async () => {
    // ddmin never tries the empty set, so a failure on load alone kept one action.
    const out = await minimizeActions([1, 2, 3, 4], async () => true);
    expect(out).toEqual({ reproduced: true, minimized: [] });
  });

  it("checks an empty set once, and reports whether it reproduced", async () => {
    expect(await minimizeActions([], async () => true)).toEqual({ reproduced: true, minimized: [] });
    expect(await minimizeActions([], async () => false)).toEqual({ reproduced: false, minimized: [] });
  });

  it("runs ddmin once the full set reproduces and the empty one does not", async () => {
    const out = await minimizeActions([1, 2, 3, 4, 5, 6, 7, 8], async (s) => s.includes(3) && s.includes(7));
    expect(out).toEqual({ reproduced: true, minimized: [3, 7] });
  });
});

describe("traceWithActions", () => {
  it("keeps every non-action entry and drops unselected actions", () => {
    const a1 = action(1);
    const a2 = action(2);
    const a3 = action(3);
    const source: TraceEntry[] = [
      META,
      { kind: "visit", url: "http://x/" },
      a1,
      a2,
      { kind: "visit", url: "http://x/b" },
      a3,
    ];
    const keep = new Set([a1, a3]);
    const out = traceWithActions(source, keep);
    expect(out).toEqual([
      META,
      { kind: "visit", url: "http://x/" },
      a1,
      { kind: "visit", url: "http://x/b" },
      a3,
    ]);
  });

  it("preserves the original meta → visit order even when all actions are removed", () => {
    const a = action(1);
    const out = traceWithActions(
      [META, { kind: "visit", url: "/" }, a],
      new Set()
    );
    expect(out).toEqual([META, { kind: "visit", url: "/" }]);
  });
});

describe("reportMatches", () => {
  function cluster(fingerprint: string): ErrorCluster {
    const sample: PageError = { type: "console", message: fingerprint, timestamp: 0 };
    return {
      key: `console|${fingerprint}`,
      type: "console",
      fingerprint,
      sample,
      count: 1,
      urls: [],
    };
  }
  function report(clusters: ErrorCluster[]): CrawlReport {
    return {
      baseUrl: "http://x/",
      seed: 0,
      reproCommand: "",
      startTime: 0,
      endTime: 0,
      duration: 0,
      pagesVisited: 0,
      totalErrors: 0,
      totalWarnings: 0,
      blockedExternalNavigations: 0,
      recoveryCount: 0,
      pages: [],
      actions: [],
      summary: {
        successPages: 0,
        errorPages: 0,
        timeoutPages: 0,
        recoveredPages: 0,
        pagesWithErrors: 0,
        consoleErrors: 0,
        networkErrors: 0,
        jsExceptions: 0,
        unhandledRejections: 0,
        invariantViolations: 0,
        avgLoadTime: 0,
      },
      errorClusters: clusters,
    };
  }

  it("is true when any fingerprint matches the regex", () => {
    expect(reportMatches(report([cluster("Cannot read property")]), /Cannot read/)).toBe(true);
  });

  it("is false when no cluster fingerprint matches", () => {
    expect(reportMatches(report([cluster("some other error")]), /Cannot read/)).toBe(false);
  });

  it("is false on an empty clusters array", () => {
    expect(reportMatches(report([]), /./)).toBe(false);
  });
});
