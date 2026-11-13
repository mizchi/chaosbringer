import type { CrawlReport, PageResult } from "chaosbringer";
import { describe, expect, it } from "vitest";
import {
  chooseChromiumShm,
  crawlOptionsFor,
  improvementOf,
  metricValues,
  missingValueReason,
  runNotes,
  runSummary,
  withDevShm,
} from "./measure.js";
import cssImportChain from "./patterns/css-import-chain.js";
import eagerIframes from "./patterns/eager-iframes.js";

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

  it("uses absentAs for a span metric a matching span left out", () => {
    const click = (interaction?: { maxDurationMs: number }) => ({ key: "/ :: click #go", durationMs: 5, network: {}, ...(interaction ? { interaction } : {}) });
    const r = {
      pages: [{ perf: load("/", 10) }],
      actions: [{ perf: click({ maxDurationMs: 200 }) }, { perf: click() }, {}],
      perf: { degradation: [] },
    } as unknown as CrawlReport;
    expect(metricValues(r, "/ :: click *", "interaction.maxDurationMs").values).toEqual([200]);
    expect(metricValues(r, "/ :: click *", "interaction.maxDurationMs", 0)).toEqual({ values: [200, 0], keys: ["/ :: click #go"] });
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

describe("missingValueReason", () => {
  it("tells apart no perfPage, collectorMissing and an absent field", () => {
    const noPerfPage = {
      ...report([{ perf: load("/", 10) as never }]),
      warnings: [{ code: "perf-session-failed", message: "perf could not attach to http://127.0.0.1/", count: 1 }],
    } as unknown as CrawlReport;
    const collectorMissing = report([{ perf: load("/", 10) as never, perfPage: { vitals: {}, network: {}, collectorMissing: true } as never }]);
    const absent = report([
      { perf: load("/", 10) as never, perfPage: { vitals: { TTFB: { value: 80 } }, network: {} } as never, metrics: {}, settleCapped: 0 },
    ]);
    const metric = "page.vitals.FCP.value";
    for (const r of [noPerfPage, collectorMissing, absent]) expect(metricValues(r, "/ :: load", metric).values).toEqual([]);
    const reasons = [noPerfPage, collectorMissing, absent].map((r) => missingValueReason(r, "/ :: load", metric));
    expect(new Set(reasons).size).toBe(3);
    expect(reasons[0]).toMatch(/^no perfPage .*perf-session-failed: perf could not attach/);
    expect(reasons[1]).toBe("collectorMissing");
    expect(reasons[2]).toBe("vitals.FCP.value absent; vitals has [TTFB]; raw metrics fcp=– lcp=–; settleCapped=0");
  });

  it("prints the raw metrics a page did record", () => {
    const r = report([
      { perf: load("/", 10) as never, perfPage: { vitals: { TTFB: { value: 80 } }, network: {} } as never, metrics: { fcp: 412.5, lcp: 430 } },
    ]);
    expect(missingValueReason(r, "/ :: load", "page.vitals.FCP.value")).toBe(
      "vitals.FCP.value absent; vitals has [TTFB]; raw metrics fcp=412.5 lcp=430; settleCapped=–",
    );
  });

  it("names a paint wait that did not get its paint, and the budgets left unmeasured", () => {
    const r = report([
      {
        perf: load("/", 10) as never,
        perfPage: { vitals: { TTFB: { value: 80 } }, network: {} } as never,
        metrics: { lcp: 24 },
        settleCapped: 0,
        paintWait: { outcome: "timeout", waitedMs: 1000, pending: ["fcp"], stillPending: ["fcp"] },
        budgetUnmeasured: [{ metric: "fcp", reason: "stalled", message: "frames stopped" }],
      },
    ]);
    expect(missingValueReason(r, "/ :: load", "page.vitals.FCP.value")).toBe(
      "vitals.FCP.value absent; vitals has [TTFB]; raw metrics fcp=– lcp=24; settleCapped=0; paintWait=timeout[fcp]; budgetUnmeasured=fcp:stalled",
    );
  });

  it("names the keys when no page's load key matched", () => {
    const r = report([{ perf: load("/about", 10) as never }, { perf: load("/docs", 10) as never }, {}]);
    expect(missingValueReason(r, "/ :: load", "page.vitals.FCP.value")).toBe(
      "no page with load key matching / :: load (keys: /about :: load, /docs :: load)",
    );
    expect(missingValueReason(report([]), "/ :: load", "page.vitals.FCP.value")).toBe("no page with load key matching / :: load (keys: none)");
  });

  it("gives one reason per distinct cause across the matching pages", () => {
    const r = report([
      { perf: load("/", 10) as never },
      { perf: load("/", 10) as never, perfPage: { vitals: {}, network: {}, collectorMissing: true } as never },
      { perf: load("/", 10) as never, perfPage: { vitals: {}, network: {}, collectorMissing: true } as never },
    ]);
    expect(missingValueReason(r, "/ :: load", "page.vitals.FCP.value")).toBe("no perfPage (no warnings) | collectorMissing");
  });

  it("reads span metrics off the spans", () => {
    const r = {
      pages: [{ perf: load("/", 10) }],
      actions: [{ perf: { key: "/ :: click #go", durationMs: 5, network: {} } }],
      perf: { degradation: [] },
    } as unknown as CrawlReport;
    expect(missingValueReason(r, "/ :: click *", "interaction.maxDurationMs")).toBe("interaction.maxDurationMs absent on / :: click #go");
    expect(missingValueReason(r, "/ :: submit *", "durationMs")).toBe(
      "no span matched / :: submit * (keys: / :: click #go, / :: load)",
    );
  });

  it("reads degradation metrics off the degradation entries", () => {
    const r = { pages: [], actions: [], perf: { degradation: [{ key: "/ :: load", fault: "slow-6s", delta: {} }] } } as unknown as CrawlReport;
    expect(missingValueReason(r, "/ :: load", "degradation.delta.effectiveMs")).toBe("delta.effectiveMs absent on / :: load [slow-6s]");
    expect(missingValueReason(r, "/x :: load", "degradation.delta.effectiveMs")).toBe(
      "no degradation entry matched /x :: load (keys: / :: load)",
    );
  });
});

describe("withDevShm", () => {
  const flag = "--disable-dev-shm-usage";

  it("drops Playwright's --disable-dev-shm-usage and keeps the pattern's args", () => {
    expect(withDevShm(undefined)).toEqual({ ignoreDefaultArgs: [flag] });
    expect(withDevShm({ args: ["--site-per-process"] })).toEqual({ args: ["--site-per-process"], ignoreDefaultArgs: [flag] });
  });

  it("merges into an ignoreDefaultArgs list without duplicating", () => {
    expect(withDevShm({ ignoreDefaultArgs: ["--hide-scrollbars"] }).ignoreDefaultArgs).toEqual(["--hide-scrollbars", flag]);
    expect(withDevShm({ ignoreDefaultArgs: [flag] }).ignoreDefaultArgs).toEqual([flag]);
  });

  it("keeps ignoreDefaultArgs: true", () => {
    expect(withDevShm({ ignoreDefaultArgs: true }).ignoreDefaultArgs).toBe(true);
  });
});

describe("chooseChromiumShm", () => {
  const GiB = 1024 ** 3;
  const TMPFS = 0x01021994;
  const EXT4 = 0xef53;
  const fs = (table: Record<string, { type: number; freeBytes: number } | "throws">) => (path: string) => {
    const e = table[path];
    if (!e || e === "throws") throw new Error(`ENOENT: ${path}`);
    return { type: e.type, bavail: e.freeBytes / 4096, bsize: 4096 };
  };
  const runner = fs({ "/dev/shm": { type: TMPFS, freeBytes: 7.8 * GiB }, "/tmp": { type: EXT4, freeBytes: 20 * GiB } });
  const base = { platform: "linux" as NodeJS.Platform, setting: undefined as string | undefined, tmpdir: "/tmp", statfs: runner };

  it("uses /dev/shm when it is a large tmpfs, and says where $TMPDIR is", () => {
    expect(chooseChromiumShm(base)).toEqual({
      devShm: true,
      line: "chromium shared memory: /dev/shm; /dev/shm is tmpfs (7.8 GiB free); $TMPDIR=/tmp is ext4 (20.0 GiB free)",
    });
  });

  it("keeps Playwright's default ($TMPDIR) and says why otherwise", () => {
    const cases: Array<[Partial<typeof base>, string]> = [
      [{ setting: "tmp" }, "PERF_PATTERN_SHM=tmp"],
      [{ platform: "darwin" }, "not Linux"],
      [{ statfs: fs({ "/dev/shm": { type: TMPFS, freeBytes: 64 * 1024 ** 2 }, "/tmp": { type: EXT4, freeBytes: GiB } }) }, "/dev/shm under 512 MiB free"],
      [{ statfs: fs({ "/dev/shm": { type: TMPFS, freeBytes: 512 * 1024 ** 2 - 4096 }, "/tmp": { type: EXT4, freeBytes: GiB } }) }, "/dev/shm under 512 MiB free"],
      [{ statfs: fs({ "/dev/shm": { type: EXT4, freeBytes: GiB }, "/tmp": { type: EXT4, freeBytes: GiB } }) }, "/dev/shm is not tmpfs"],
      [{ statfs: fs({ "/dev/shm": "throws", "/tmp": { type: TMPFS, freeBytes: GiB } }) }, "/dev/shm unreadable"],
    ];
    for (const [over, why] of cases) {
      const shm = chooseChromiumShm({ ...base, ...over });
      expect(shm.devShm, why).toBe(false);
      expect(shm.line, why).toMatch(new RegExp(`^chromium shared memory: \\$TMPDIR \\(${why.replace(/[$()]/g, "\\$&")}\\); `));
    }
  });

  it("names a filesystem it has no name for by its magic, and an unreadable one as such", () => {
    const shm = chooseChromiumShm({ ...base, tmpdir: "/scratch", statfs: fs({ "/dev/shm": { type: TMPFS, freeBytes: GiB }, "/scratch": { type: 0x1234, freeBytes: GiB } }) });
    expect(shm.line).toBe("chromium shared memory: /dev/shm; /dev/shm is tmpfs (1.0 GiB free); $TMPDIR=/scratch is fs 0x1234 (1.0 GiB free)");
    expect(chooseChromiumShm({ ...base, tmpdir: "/gone" }).line).toMatch(/\$TMPDIR=\/gone is unreadable$/);
  });

  it("takes /dev/shm with exactly 512 MiB free", () => {
    // What an empty `docker run --shm-size=512m` /dev/shm reports.
    const shm = chooseChromiumShm({ ...base, statfs: fs({ "/dev/shm": { type: TMPFS, freeBytes: 512 * 1024 ** 2 }, "/tmp": { type: EXT4, freeBytes: GiB } }) });
    expect(shm.devShm).toBe(true);
  });

  it("rejects an unknown PERF_PATTERN_SHM", () => {
    expect(() => chooseChromiumShm({ ...base, setting: "shm" })).toThrow(/PERF_PATTERN_SHM/);
    expect(chooseChromiumShm({ ...base, setting: "" }).devShm).toBe(true);
  });
});

describe("crawlOptionsFor", () => {
  const flag = "--disable-dev-shm-usage";
  const origin = "http://127.0.0.1:4100";

  it("drops --disable-dev-shm-usage with devShm and keeps a pattern's own launch args", () => {
    const o = crawlOptionsFor(eagerIframes, origin, { headless: true, devShm: true });
    expect(o.launchOptions).toEqual({ args: ["--site-per-process"], ignoreDefaultArgs: [flag] });
    expect(o.blockExternalNavigation).toBe(false);
    expect(crawlOptionsFor(cssImportChain, origin, { headless: true, devShm: true }).launchOptions).toEqual({ ignoreDefaultArgs: [flag] });
  });

  it("leaves launchOptions as the pattern has them without devShm (PERF_PATTERN_SHM=tmp)", () => {
    expect(crawlOptionsFor(eagerIframes, origin, { headless: true, devShm: false }).launchOptions).toEqual({ args: ["--site-per-process"] });
    expect(crawlOptionsFor(cssImportChain, origin, { headless: true, devShm: false })).not.toHaveProperty("launchOptions");
  });

  it("crawls the pattern's entry at its seed with perf and adaptive settle by default", () => {
    expect(crawlOptionsFor(cssImportChain, origin, { headless: false, devShm: false })).toMatchObject({
      baseUrl: `${origin}/`,
      seed: cssImportChain.crawl.seed,
      maxPages: cssImportChain.crawl.maxPages,
      settle: "adaptive",
      perf: true,
      headless: false,
    });
  });
});

describe("runSummary", () => {
  const expectFcp = { key: "/ :: load", metric: "page.vitals.FCP.value", alsoExpect: [{ metric: "page.vitals.LCP.value", direction: "lower" as const, minImprovement: {} }] };

  it("gives the values, the also values and no reason for a run with a value", () => {
    const r = report([{ perf: load("/", 10) as never, perfPage: { vitals: { FCP: { value: 280 }, LCP: { value: 300 } }, network: {} } as never }]);
    expect(runSummary(r, expectFcp)).toEqual({ values: [280], keys: ["/ :: load"], also: [[300]], missing: undefined, warnings: [] });
  });

  it("names the reason, and the run's warning codes, for a run with no value", () => {
    const r = {
      ...report([{ perf: load("/", 10) as never, perfPage: { vitals: { TTFB: { value: 80 } }, network: {} } as never, metrics: {} }]),
      warnings: [{ code: "network-profile-failed", message: "could not apply the network profile", count: 1 }],
    } as unknown as CrawlReport;
    expect(runSummary(r, expectFcp)).toEqual({
      values: [],
      keys: ["/ :: load"],
      also: [[]],
      missing: "vitals.FCP.value absent; vitals has [TTFB]; raw metrics fcp=– lcp=–; settleCapped=–",
      warnings: ["network-profile-failed"],
    });
  });
});

describe("runNotes", () => {
  it("prints each run's warnings and, for any variant, why a run gave no value", () => {
    const fixed = { variant: "fixed" as const, warningsPerRun: [[], ["perf-session-failed"], []], missingPerRun: [undefined, "no perfPage (no warnings)", undefined] };
    expect(runNotes("css-import-chain", "page.vitals.FCP.value", fixed)).toEqual([
      "[css-import-chain]   fixed run 1 warnings: perf-session-failed",
      "[css-import-chain]   fixed run 1: no page.vitals.FCP.value (no perfPage (no warnings))",
    ]);
    expect(runNotes("x", "durationMs", { variant: "slow", warningsPerRun: [[]], missingPerRun: [undefined] })).toEqual([]);
  });
});
