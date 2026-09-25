import { describe, expect, it } from "vitest";
import { ACTION_REQUEST_DRAIN_MS, PagePerf } from "./perf.js";
import type { PageResult } from "./types.js";

/**
 * `finish()` has an outer deadline because some of lightbringer's finish
 * work is a CDP call with no bound of its own (stopJSCoverage and a forced
 * GC wait on the renderer's main thread). A session whose finish never
 * settles stands in for a page stuck in `while (true) {}` under --perf-cov.
 */
function stuckPerf(): PagePerf {
  const session = {
    controller: { spans: [], cancel() {}, async end() {}, async begin() {} },
    finish: () => new Promise<never>(() => {}),
  };
  const client = { send: async () => ({}) };
  // The constructor is private to keep callers on `open()`, which needs a
  // real page; the fields it takes are all this test exercises.
  const Ctor = PagePerf as unknown as new (...args: unknown[]) => PagePerf;
  return new Ctor(session, client, "http://x/", { level: "light" }, "slug");
}

describe("PagePerf.finish deadline", () => {
  it("rejects instead of hanging when lightbringer's finish never settles", async () => {
    const result = { url: "http://x/" } as PageResult;
    const t0 = Date.now();
    await expect(stuckPerf().finish(result, { timeoutMs: 50 })).rejects.toThrow(/timed out after 50ms/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.perf).toBeUndefined();
  });
});

/**
 * B2 follow-up: under `networkidle` a click's fetch is not waited for, so
 * when the click was the page's last step the report was built before the
 * fetch answered and the span had no `settledMs`. `finish()` now waits
 * (bounded) for requests action spans started.
 */
describe("PagePerf.finish drains the action spans' requests", () => {
  function drainPerf(unsettledPolls: number, page?: { url: () => string; isClosed: () => boolean }) {
    const spans: Array<{ name: string }> = [];
    let polls = 0;
    let builtAtPoll = -1;
    const session = {
      controller: {
        spans,
        cancel() {},
        async begin(name: string) {
          return { name };
        },
        async end(h: { name: string }) {
          spans.push({ name: h.name });
        },
      },
      peekSpan: (i: number) => {
        if (spans[i]?.name !== "action") return { network: {} };
        polls++;
        return { network: polls <= unsettledPolls ? { settledUnfinished: true } : { settledMs: 300 } };
      },
      finish: async () => {
        builtAtPoll = polls;
        return { report: { spans: [], network: { thirdParty: { requestCount: 0 } } } };
      },
    };
    const Ctor = PagePerf as unknown as new (...args: unknown[]) => PagePerf;
    const perf = new Ctor(session, { send: async () => ({}) }, "http://x/", { level: "light" }, "slug", [], page);
    return { perf, polls: () => polls, builtAtPoll: () => builtAtPoll };
  }
  const click = { type: "click", selector: "#r", target: "#r", success: true, timestamp: 0 } as const;

  async function run(p: PagePerf, opts: { navigationFailed?: boolean } = {}) {
    await p.beginLoad();
    await p.endLoad();
    const h = await p.beginAction();
    await p.endAction(h, { ...click });
    const t0 = Date.now();
    await p.finish({ url: "http://x/" } as PageResult, opts).catch(() => {});
    return Date.now() - t0;
  }

  it("waits until the action's request is over before building the report", async () => {
    const d = drainPerf(3);
    await run(d.perf);
    expect(d.builtAtPoll()).toBeGreaterThanOrEqual(4);
  });

  it("does not wait when no action request is running", async () => {
    const d = drainPerf(0);
    await run(d.perf);
    expect(d.builtAtPoll()).toBe(1);
  });

  it("stops waiting at the cap, and at once on a closed page or a failed navigation", async () => {
    const forever = drainPerf(Number.POSITIVE_INFINITY);
    const ms = await run(forever.perf);
    expect(ms).toBeGreaterThanOrEqual(ACTION_REQUEST_DRAIN_MS - 50);
    expect(ms).toBeLessThan(ACTION_REQUEST_DRAIN_MS + 2000);
    const closed = drainPerf(Number.POSITIVE_INFINITY, { url: () => "http://x/", isClosed: () => true });
    expect(await run(closed.perf)).toBeLessThan(500);
    const failed = drainPerf(Number.POSITIVE_INFINITY);
    expect(await run(failed.perf, { navigationFailed: true })).toBeLessThan(500);
    expect(failed.polls()).toBe(0);
  }, 10_000);
});
