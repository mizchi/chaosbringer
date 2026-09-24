import { describe, expect, it } from "vitest";
import { PagePerf } from "./perf.js";
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
