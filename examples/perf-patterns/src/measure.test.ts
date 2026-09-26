import type { CrawlReport, PageResult } from "chaosbringer";
import { describe, expect, it } from "vitest";
import { improvementOf, metricValues } from "./measure.js";

/** A crawl report with only what `metricValues` reads. */
function report(pages: Array<Partial<PageResult>>): CrawlReport {
  return { pages, actions: [], perf: { degradation: [] } } as unknown as CrawlReport;
}

const load = (route: string, durationMs: number) => ({ key: `${route} :: load`, durationMs, network: { settledMs: 0 } });

describe("metricValues", () => {
  it("reads page. metrics off perfPage of the pages whose load key matches", () => {
    const r = report([
      { perf: load("/", 10) as never, perfPage: { vitals: { CLS: { value: 0.3 } }, network: { thirdParty: { encodedKB: 500 } } } as never },
      { perf: load("/about", 10) as never, perfPage: { vitals: { CLS: { value: 0.9 } }, network: {} } as never },
      { perf: load("/", 10) as never, perfPage: { vitals: { CLS: { value: 0.1 } }, network: {} } as never },
    ]);
    expect(metricValues(r, "/ :: load", "page.vitals.CLS.value")).toEqual({ values: [0.3, 0.1], keys: ["/ :: load"] });
    expect(metricValues(r, "* :: load", "page.vitals.CLS.value").values).toEqual([0.3, 0.9, 0.1]);
  });

  it("uses absentAs only for a field a measured page left out", () => {
    const r = report([
      { perf: load("/", 10) as never, perfPage: { vitals: {}, network: { thirdParty: { encodedKB: 500 } } } as never },
      { perf: load("/", 10) as never, perfPage: { vitals: {}, network: {} } as never },
      { perf: load("/", 10) as never, perfPage: { vitals: {}, network: {}, collectorMissing: true } as never },
      { perf: load("/", 10) as never },
    ]);
    expect(metricValues(r, "/ :: load", "page.network.thirdParty.encodedKB").values).toEqual([500]);
    expect(metricValues(r, "/ :: load", "page.network.thirdParty.encodedKB", 0).values).toEqual([500, 0]);
  });

  it("keeps reading span metrics off the spans", () => {
    const r = report([{ perf: load("/", 42) as never, perfPage: { vitals: {}, network: {} } as never }]);
    expect(metricValues(r, "/ :: load", "durationMs").values).toEqual([42]);
    expect(metricValues(r, "/ :: load", "effectiveMs").values).toEqual([42]);
  });
});

describe("improvementOf", () => {
  it("checks every bound", () => {
    expect(improvementOf({ minImprovement: { ratio: 5, absolute: 0.1 } }, 0.3, 0)).toEqual({
      absolute: 0.3,
      ratio: Number.POSITIVE_INFINITY,
      ok: true,
    });
    expect(improvementOf({ minImprovement: { ratio: 5 } }, 4, 1).ok).toBe(false);
    expect(improvementOf({ minImprovement: { ratio: 2 } }, null, 1).ok).toBe(false);
  });
});
