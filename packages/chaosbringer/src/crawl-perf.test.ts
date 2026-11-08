/**
 * `CrawlPerf`'s failure path: a page whose perf session did not open, or did
 * not finish, is a `perf-session-failed` warning. It used to be a logger line
 * only, which writes nowhere by default, so `perfBudgets` passed a page it
 * had measured nothing on without a word.
 */
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrawlPerf } from "./crawl-perf.js";
import { PagePerf } from "./perf.js";
import { resolvePerfOptions } from "./perf-options.js";
import type { RunWarningInput } from "./run-warnings.js";
import type { PageResult } from "./types.js";

function recorder() {
  const calls: Array<{ event: string; warning: RunWarningInput }> = [];
  const warn = (event: string, _data: Record<string, unknown>, warning: RunWarningInput) => {
    calls.push({ event, warning });
  };
  return { calls, warn };
}

const result = (url: string): PageResult => ({ url, status: "success", loadTime: 1, errors: [], warnings: [], links: [] });

describe("CrawlPerf", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns on a page whose perf session did not open", async () => {
    const { calls, warn } = recorder();
    const perf = new CrawlPerf(resolvePerfOptions(true), warn, undefined);
    vi.spyOn(PagePerf, "open").mockRejectedValue(new Error("Target closed"));
    await perf.beginPage({} as Page, "http://x/a", { installCollector: false, pageFaults: [] });
    expect(calls).toEqual([
      {
        event: "perf_session_failed",
        warning: {
          code: "perf-session-failed",
          message: "perf measurement could not start on a page (Target closed), so that page has no perf spans and perfBudgets checked nothing on it",
          url: "http://x/a",
        },
      },
    ]);
    expect(await perf.finishPage(result("http://x/a"), "http://x/a", { navigationFailed: false })).toEqual([]);
  });

  it("warns on a page whose perf session did not finish", async () => {
    const { calls, warn } = recorder();
    const perf = new CrawlPerf(resolvePerfOptions(true), warn, undefined);
    const open = {
      beginLoad: async () => {},
      noteFault: () => {},
      finish: async () => {
        throw new Error("Session closed");
      },
    };
    vi.spyOn(PagePerf, "open").mockResolvedValue(open as unknown as PagePerf);
    await perf.beginPage({} as Page, "http://x/b", { installCollector: false, pageFaults: [] });
    expect(calls).toEqual([]);
    expect(await perf.finishPage(result("http://x/b"), "http://x/b", { navigationFailed: false })).toEqual([]);
    expect(calls.map((c) => [c.event, c.warning.code, c.warning.url])).toEqual([["perf_finish_failed", "perf-session-failed", "http://x/b"]]);
    expect(calls[0]?.warning.message).toMatch(/^perf measurement of a page could not finish \(Session closed\)/);
  });

  it("warns on nothing with perf off", async () => {
    const { calls, warn } = recorder();
    const perf = new CrawlPerf(resolvePerfOptions(undefined), warn, undefined);
    await perf.beginPage({} as Page, "http://x/", { installCollector: false, pageFaults: [] });
    expect(calls).toEqual([]);
  });
});
