import type { CrawlReport } from "chaosbringer";
import { describe, expect, it } from "vitest";
import { budgetsWorkdir, emitBudgetsCli, gateCli, headroomSetAll } from "./budgets.js";

/** A crawl report with one page whose load span has these values (the rest 0). */
function report(scriptMs: number, blockingMs: number): CrawlReport {
  const span = {
    name: "/ :: load",
    key: "/ :: load",
    durationMs: 10,
    capped: false,
    traceWindowUs: [0, 0],
    network: { requestCount: 0, encodedKB: 0, busyMs: 0, waves: 0, requests: [] },
    cpu: { longTaskCount: 0, blockingMs, maxLongTaskMs: 0 },
    render: { scriptMs, layoutCount: 0, layoutMs: 0, recalcStyleCount: 0, recalcStyleMs: 0, nodes: 0 },
    memory: {},
  };
  return {
    pages: [{ url: "http://127.0.0.1/", status: "success", loadTime: 0, errors: [], hasErrors: false, warnings: [], links: [], perf: span }],
    actions: [],
  } as unknown as CrawlReport;
}

describe("headroomSetAll", () => {
  it("tells a ceil(median × 1.25) budget from a ceil(median + floor) one", async () => {
    const work = budgetsWorkdir("unit");
    try {
      // scriptMs 44: 44 × 1.25 = 55 > 44 + 8. blockingMs 0: 0 + 5 > 0.
      const base = [report(44, 0), report(44, 0), report(44, 0)];
      const budgets = await emitBudgetsCli(work.dir, base);
      const over = await gateCli(work.dir, "over", [report(57, 6)], budgets);
      const byMetric = (m: string) => over.violations.filter((v) => v.metric === m);
      expect(byMetric("scriptMs")).toMatchObject([{ scope: "/ :: load", limit: 55 }]);
      expect(byMetric("blockingMs")).toMatchObject([{ scope: "/ :: load", limit: 5 }]);
      expect(await headroomSetAll(work.dir, base, byMetric("scriptMs"))).toBe(true);
      expect(await headroomSetAll(work.dir, base, byMetric("blockingMs"))).toBe(false);
      expect(await headroomSetAll(work.dir, base, over.violations)).toBe(false);
    } finally {
      work.dispose();
    }
  });
});
