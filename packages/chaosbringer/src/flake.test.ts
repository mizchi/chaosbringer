import { afterEach, describe, expect, it, vi } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { packageVersion, UsageError } from "./cli-usage.js";
import {
  flakeExitCode,
  flakeReport,
  formatFlakeReport,
  parseFlakeArgs,
  pastedCrawlArgs,
  perRunOptions,
  perRunPath,
} from "./flake.js";
import { buildReproCommand } from "./repro-command.js";
import { cliOptions, comparable, resolved, ROUND_TRIPS, shellWords, URL } from "./repro-flags.test-helpers.js";
import type { RunWarning } from "./run-warnings.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function summary(over: Partial<CrawlSummary> = {}): CrawlSummary {
  return {
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
    ...over,
  };
}

function cluster(key: string, count: number): ErrorCluster {
  const sample: PageError = { type: "console", message: key, timestamp: 0 };
  return { key, type: "console", fingerprint: key, sample, count, urls: [] };
}

function page(over: Partial<PageResult> & { url: string }): PageResult {
  return {
    url: over.url,
    status: over.status ?? "success",
    loadTime: 0,
    errors: over.errors ?? [],
    hasErrors: (over.errors ?? []).length > 0,
    warnings: [],
    links: [],
    ...over,
  };
}

function makeReport(over: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://x/",
    seed: 1,
    reproCommand: "",
    startTime: 0,
    endTime: 0,
    duration: 100,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: summary(),
    errorClusters: [],
    ...over,
  };
}

describe("flakeReport", () => {
  it("labels clusters that fire in every run as stable", () => {
    const r = [
      makeReport({ errorClusters: [cluster("k1", 2)] }),
      makeReport({ errorClusters: [cluster("k1", 3)] }),
      makeReport({ errorClusters: [cluster("k1", 1)] }),
    ];
    const analysis = flakeReport(r);
    expect(analysis.runs).toBe(3);
    expect(analysis.stableClusters.map((c) => c.key)).toEqual(["k1"]);
    expect(analysis.stableClusters[0]!.perRunCounts).toEqual([2, 3, 1]);
    expect(analysis.flakyClusters).toEqual([]);
  });

  it("labels clusters that fire in some but not all runs as flaky", () => {
    const r = [
      makeReport({ errorClusters: [cluster("k1", 2), cluster("k2", 1)] }),
      makeReport({ errorClusters: [cluster("k1", 2)] }),
      makeReport({ errorClusters: [cluster("k1", 2), cluster("k2", 1)] }),
    ];
    const analysis = flakeReport(r);
    expect(analysis.stableClusters.map((c) => c.key)).toEqual(["k1"]);
    expect(analysis.flakyClusters.map((c) => c.key)).toEqual(["k2"]);
    expect(analysis.flakyClusters[0]!.runsWithCluster).toBe(2);
    expect(analysis.flakyClusters[0]!.perRunCounts).toEqual([1, 0, 1]);
  });

  it("only reports a page as flaky when its outcome varies across visits", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const reports = [
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
    ];
    const analysis = flakeReport(reports);
    expect(analysis.flakyPages.map((p) => p.url)).toEqual(["http://x/a"]);
    expect(analysis.flakyPages[0]!.failedInRuns).toBe(2);
    expect(analysis.flakyPages[0]!.visitedInRuns).toBe(3);
  });

  it("does not flag pages that fail in every run as flaky", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const reports = [
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
    ];
    expect(flakeReport(reports).flakyPages).toEqual([]);
  });

  it("returns an empty analysis for zero runs, marked undecidable", () => {
    // The empty lists are the same shape a clean result has, and the CLI turns
    // `flakyClusters.length === 0` into a green gate. `decidable` is what keeps
    // "nothing flaked" apart from "nothing was measured".
    expect(flakeReport([])).toEqual({
      runs: 0,
      decidable: false,
      verdicts: [],
      verdictFlaky: false,
      stableClusters: [],
      flakyClusters: [],
      flakyPages: [],
      durations: [],
      warnings: [],
    });
  });

  it("lists the runs' warnings once each, their counts added, and prints them", () => {
    const warning = { code: "sitemap-unreadable" as const, message: "sitemap s could not be read", count: 1 };
    const run = (warnings?: (typeof warning)[]) => makeReport({ warnings });
    const analysis = flakeReport([run([warning]), run([warning]), run(undefined)]);
    expect(analysis.warnings).toEqual([{ ...warning, count: 2 }]);
    expect(formatFlakeReport(analysis)).toContain("  [sitemap-unreadable] sitemap s could not be read (×2)");
  });

  it("refuses to call anything stable or flaky from a single run", () => {
    const err = { type: "console" as const, message: "boom", url: "http://x/a" };
    const one = flakeReport([
      makeReport({
        errorClusters: [cluster("seen-once", 1)],
        pages: [page({ url: "http://x/a", errors: [err] })],
      }),
    ]);
    expect(one.decidable).toBe(false);
    // The cluster is still listed — one run is enough to say what happened —
    // but `flakyClusters` being empty here is arithmetic, not evidence: with
    // one run every cluster fired in "every" run.
    expect(one.stableClusters).toHaveLength(1);
    expect(one.flakyClusters).toEqual([]);
  });

  it("becomes decidable at two runs", () => {
    const two = flakeReport([makeReport({}), makeReport({})]);
    expect(two.decidable).toBe(true);
  });

  it("says so in the formatted report instead of printing a verdict", () => {
    const text = formatFlakeReport(flakeReport([makeReport({ errorClusters: [cluster("c", 1)] })]));
    expect(text).toContain("UNDECIDABLE");
    expect(text).toContain("at least 2 runs");
    // And it must not print the line that claims stability.
    expect(text).not.toContain("Stable clusters (fire every run)");
    expect(text).toContain("stability undecidable");
  });

  it("prints the ordinary verdict once there are enough runs", () => {
    const text = formatFlakeReport(
      flakeReport([
        makeReport({ errorClusters: [cluster("c", 1)] }),
        makeReport({ errorClusters: [cluster("c", 1)] }),
      ]),
    );
    expect(text).not.toContain("UNDECIDABLE");
    expect(text).toContain("Stable clusters (fire every run)");
  });

  it("preserves input order for durations", () => {
    const reports = [makeReport({ duration: 100 }), makeReport({ duration: 50 }), makeReport({ duration: 200 })];
    expect(flakeReport(reports).durations).toEqual([100, 50, 200]);
  });
});

describe("flake CLI arguments", () => {
  // Not a parser unit test for its own sake: the weekly workflow that runs
  // this passed the *root* command's spelling of a shared option, strict
  // `parseArgs` refused it, and `|| true` hid the failure.
  const base = ["--url", "http://x", "--runs", "2"];

  it("accepts either spelling of the per-page action cap", () => {
    expect(parseFlakeArgs([...base, "--max-actions", "5"]).options.maxActionsPerPage).toBe(5);
    expect(parseFlakeArgs([...base, "--max-actions-per-page", "5"]).options.maxActionsPerPage).toBe(5);
  });

  it("leaves it unset when neither is given", () => {
    expect(parseFlakeArgs(base).options.maxActionsPerPage).toBeUndefined();
  });

  it("reads an empty number as unset, as the main crawl does", () => {
    // `flake --max-pages "$MAX"` with MAX unset exited 2 on `--max-pages must
    // be >= 1 (got 0)`; the main command runs with the default.
    const args = parseFlakeArgs([...base, "--max-pages", "", "--max-actions", "", "--timeout", ""]);
    expect(args.options).toMatchObject({ maxPages: undefined, maxActionsPerPage: undefined, timeout: undefined });
  });

  it("still refuses a flag no spelling covers, naming the one it misspells", () => {
    // The alias must not become "accept anything": an unknown flag has to stay
    // an error, because being refused is what makes a typo visible at all.
    expect(() => parseFlakeArgs([...base, "--max-action", "5"])).toThrow(
      "unknown option --max-action: did you mean --max-actions?",
    );
    expect(() => parseFlakeArgs([...base, "--bogus"])).toThrow("Unknown option '--bogus'");
  });

  // `flake --exclude`, `--strict`, `--settle`, … exited 2 as unknown options,
  // so a crawl that needed one could not be flake-checked with it.
  it("builds each run's options as the main crawl builds them, from every one of its flags", () => {
    const argv = ["--strict", "--exclude", "/x", "--settle", "adaptive", "--ignore-preset", "analytics", "--seed", "9"];
    const args = parseFlakeArgs([...base, ...argv]);
    expect(args.options).toEqual(cliOptions(["--url", "http://x", ...argv]));
    expect(args.exitOptions).toMatchObject({ strict: true });
  });

  it("keeps a run's seed when given, and leaves it to each run without one", () => {
    expect(parseFlakeArgs([...base, "--seed", "4"]).options.seed).toBe(4);
    expect(parseFlakeArgs(base).options.seed).toBeUndefined();
  });

  it("judges each run by the exit rules the flags ask for", () => {
    const args = parseFlakeArgs([...base, "--fail-on-http", "5xx", "--fail-on-dead-links", "--fail-on-warnings"]);
    expect(args.exitOptions).toMatchObject({ http: "5xx", deadLinks: true, warnings: true });
  });

  describe("--version", () => {
    afterEach(() => vi.restoreAllMocks());
    // It was accepted as "not applied", and flake ran every crawl.
    it("prints the version and runs nothing, as the main command does", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process, "exit").mockImplementation(((code: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      expect(() => parseFlakeArgs([...base, "--version"])).toThrow("exit 0");
      expect(log).toHaveBeenCalledWith(packageVersion());
    });
  });

  it("names the crawl flags it accepts and does not apply", () => {
    expect(parseFlakeArgs([...base, "--junit", "j.xml", "--compact", "--exclude", "/x"]).notApplied).toEqual([
      "--compact",
      "--junit",
    ]);
    expect(parseFlakeArgs(base).notApplied).toEqual([]);
  });

  it("refuses what the main crawl refuses, as a usage error", () => {
    expect(() => parseFlakeArgs([...base, "--seed", "x"])).toThrow(UsageError);
    expect(() => parseFlakeArgs([...base, "--ignore-preset", "nope"])).toThrow(/unknown ignore preset "nope"/);
    expect(() => parseFlakeArgs([...base, "--cdp-target", "x"])).toThrow(/"cdpTargetId" requires "cdpEndpoint"/);
    expect(() => parseFlakeArgs([...base, "--fail-on-http", "500"])).toThrow(/--fail-on-http must be one of/);
  });
});

describe("flake -- <a pasted crawl command>", () => {
  const url = "http://127.0.0.1:4401";

  it.each([
    [["chaosbringer"]],
    [["npx", "chaosbringer"]],
    [["npx", "-y", "chaosbringer"]],
    [["pnpm", "exec", "chaosbringer"]],
    [["node_modules/.bin/chaosbringer"]],
    [[]],
  ])("takes a Repro: line with %j in front", (prefix) => {
    const words = ["--url", url, "--seed", "9", "--exclude", "/go", "--exclude", "/broken", "--settle", "adaptive"];
    expect(pastedCrawlArgs([...prefix, ...words])).toEqual(words);
    const args = parseFlakeArgs(["--runs", "2", "--", ...prefix, ...words]);
    expect(args.options).toEqual(cliOptions(words));
    expect(args.runs).toBe(2);
  });

  it("takes the URL as the pasted command's positional", () => {
    expect(parseFlakeArgs(["--", "chaosbringer", url, "--seed", "1"]).baseUrl).toBe(url);
  });

  it("merges flags before the -- with the pasted ones", () => {
    const args = parseFlakeArgs(["--runs", "2", "--strict", "--", "chaosbringer", "--url", url, "--seed", "9"]);
    expect(args.exitOptions.strict).toBe(true);
    expect(args.options.seed).toBe(9);
    expect(args.options.baseUrl).toBe(url);
  });

  it("refuses a crawl flag or the URL given on both sides", () => {
    expect(() => parseFlakeArgs(["--seed", "1", "--", "--url", url, "--seed", "2"])).toThrow(
      "--seed is given both before and after --: give it on one side",
    );
    // One flag in two spellings is still one flag.
    expect(() => parseFlakeArgs(["--max-actions", "1", "--", "--url", url, "--max-actions-per-page", "2"])).toThrow(
      "--max-actions is given both before and after --",
    );
    expect(() => parseFlakeArgs(["--url", url, "--", "chaosbringer", url])).toThrow(
      "the URL is given both before and after --",
    );
  });

  it("refuses flake's own flags after the --", () => {
    expect(() => parseFlakeArgs(["--", "--url", url, "--runs", "3"])).toThrow(
      "--runs after --: it is flake's own flag, and goes before the --",
    );
    // The crawl's --output and --quiet mean something else before the --, so
    // the refusal does not say to move them there.
    expect(() => parseFlakeArgs(["--", "--url", url, "--output", "o.json"])).toThrow(
      "--output after -- is the crawl's report path, which flake does not write (its runs' reports are not kept); " +
        "flake's own --output, its analysis JSON, goes before the --",
    );
    expect(() => parseFlakeArgs(["--", "--url", url, "--quiet"])).toThrow(
      "--quiet after -- is the crawl's; flake's own --quiet (print only the summary) goes before the --",
    );
    expect(() => parseFlakeArgs(["--", "--url", url, "--version"])).toThrow(/^--version after --: .*no run to repeat$/);
  });

  it("refuses an unknown flag after the --, naming the one it misspells", () => {
    expect(() => parseFlakeArgs(["--", "chaosbringer", "--url", url, "--exlude", "/x"])).toThrow(
      "unknown option --exlude: did you mean --exclude?",
    );
  });

  it("refuses a command pasted as one quoted argument, and another program", () => {
    expect(() => pastedCrawlArgs([`chaosbringer --url ${url}`])).toThrow(/paste the command unquoted/);
    expect(() => pastedCrawlArgs(["npx", "playwright", "test"])).toThrow(/expected a chaosbringer command/);
    expect(() => pastedCrawlArgs(["node", "server.js"])).toThrow(/expected a chaosbringer command, got "node server.js"/);
  });

  it("takes the command as chaos-flake.yml runs it, node and the built cli.js", () => {
    expect(pastedCrawlArgs(["node", "dist/cli.js", "--url", url])).toEqual(["--url", url]);
    expect(parseFlakeArgs(["--", "node", "dist/cli.js", "--url", url]).baseUrl).toBe(url);
  });

  // The main crawl's refusal listed its subcommands, `scan` among them, right
  // after refusing `scan`.
  it("refuses a subcommand or a stray word in flake's terms, not with the subcommand list", () => {
    expect(() => parseFlakeArgs(["--runs", "2", "--", "chaosbringer", "scan", url])).toThrow(
      'unexpected argument "scan" after --: it is a subcommand, and flake reruns a plain crawl command (chaosbringer --url <url> …)',
    );
    for (const argv of [["--runs", "2", "bogus", "--url", url], ["--", "--url", url, "bogus"]]) {
      expect(() => parseFlakeArgs(argv)).toThrow(UsageError);
      expect(() => parseFlakeArgs(argv)).toThrow(
        /^unexpected argument "bogus": flake takes the URL \(--url <url>, or as the one argument\) and flags$/,
      );
    }
  });

  it("refuses a Repro line's `# + …` note that a shell passed on", () => {
    expect(() => parseFlakeArgs(["--", "chaosbringer", "--url", url, "#", "+", "1", "fault"])).toThrow(
      /unexpected argument "#"/,
    );
  });
});

// Every flag a crawl's Repro: line can carry, through a real shell, after a
// `--`: the run is the one the line describes.
describe("flake -- <every flag reproCommand emits>", () => {
  it.each(Object.entries(ROUND_TRIPS))("--%s", (_flag, argv) => {
    const before = resolved(cliOptions(["--url", URL, ...argv]));
    const words = shellWords(buildReproCommand(before, before.seed));
    const args = parseFlakeArgs(["--runs", "2", "--", ...words]);
    expect(comparable(resolved(args.options))).toEqual(comparable(before));
    // And before a --, as plain flags.
    expect(comparable(resolved(parseFlakeArgs(["--runs", "2", ...words.slice(1)]).options))).toEqual(comparable(before));
  });
});

describe("per-run outputs", () => {
  it("gives each run its own file and directory", () => {
    expect(perRunPath("t.jsonl", 2, "file")).toBe("t.run2.jsonl");
    expect(perRunPath("out/trace", 1, "file")).toBe("out/trace.run1");
    expect(perRunPath("bundles", 3, "dir")).toBe("bundles/run-3");
    const o = perRunOptions(
      cliOptions([
        "--url", URL, "--trace-out", "t.jsonl", "--failure-artifacts", "b", "--har-record", "h.har",
        "--log-file", "l.log", "--screenshots", "--screenshot-dir", "s", "--perf-out", "p",
      ]),
      2,
    );
    expect(o).toMatchObject({
      traceOut: "t.run2.jsonl",
      failureArtifacts: { dir: "b/run-2" },
      har: { path: "h.run2.har", mode: "record" },
      logFile: "l.run2.log",
      screenshotDir: "s/run-2",
      perf: { outDir: "p/run-2" },
    });
    // --screenshots alone wrote every run to the crawler's ./screenshots, each
    // over the last.
    const shots = cliOptions(["--url", URL, "--screenshots"]);
    expect(perRunOptions(shots, 1).screenshotDir).toBe("screenshots/run-1");
    expect(perRunOptions(shots, 2).screenshotDir).toBe("screenshots/run-2");
    expect(perRunOptions(cliOptions(["--url", URL]), 2).screenshotDir).toBeUndefined();
    // A file a run reads is the same for every run.
    expect(perRunOptions(cliOptions(["--url", URL, "--har-replay", "h.har"]), 2).har).toEqual({ path: "h.har", mode: "replay" });
  });
});

describe("run verdicts", () => {
  const consoleError: PageError = { type: "console", message: "boom", timestamp: 0 };
  const noisy = makeReport({ seed: 1, summary: summary({ consoleErrors: 1 }), errorClusters: [cluster("boom", 1)] });
  const clean = makeReport({ seed: 2 });

  it("calls the verdict flaky when the runs disagree under the crawl's exit rules", () => {
    const a = flakeReport([noisy, clean], { strict: true });
    expect(a.verdicts).toEqual([
      { seed: 1, passed: false, reasons: ["--strict: 1 console error"] },
      { seed: 2, passed: true, reasons: [] },
    ]);
    expect(a.verdictFlaky).toBe(true);
    expect(formatFlakeReport(a)).toContain("Verdicts (the crawl's exit rules): 1 passed, 1 failed — FLAKY");
    expect(formatFlakeReport(a)).toContain("run 1 (seed=1) FAIL: --strict: 1 console error");
  });

  it("does not, when the rules fail neither run: the cluster is still flaky", () => {
    const a = flakeReport([noisy, clean]);
    expect(a.verdictFlaky).toBe(false);
    expect(a.flakyClusters.map((c) => c.key)).toEqual(["boom"]);
    expect(formatFlakeReport(a)).toContain("Verdicts (the crawl's exit rules): every run passed");
  });

  it("does not, when every run fails alike", () => {
    const failed = makeReport({ summary: summary({ errorPages: 1 }), pages: [page({ url: "http://x/", status: "error", errors: [consoleError] })] });
    const a = flakeReport([failed, failed]);
    expect(a.verdictFlaky).toBe(false);
    expect(formatFlakeReport(a)).toContain("every run failed");
  });

  it("is never flaky from one run", () => {
    expect(flakeReport([noisy], { strict: true }).verdictFlaky).toBe(false);
  });

  // flake's exit code read the flaky clusters and pages and, until this,
  // nothing pinned that a verdict flaking alone also exits 1.
  it("exits 1 when only the verdict flaked, with no flaky cluster or page", () => {
    const warning: RunWarning = { code: "sitemap-unreadable", message: "sitemap x could not be read", count: 1 };
    const a = flakeReport([makeReport({ seed: 1, warnings: [warning] }), makeReport({ seed: 2 })], { warnings: true });
    expect(a.verdictFlaky).toBe(true);
    expect(a.flakyClusters).toEqual([]);
    expect(a.flakyPages).toEqual([]);
    expect(flakeExitCode(a)).toBe(1);
    expect(flakeExitCode(flakeReport([clean, clean], { strict: true }))).toBe(0);
    expect(flakeExitCode(flakeReport([noisy, clean]))).toBe(1);
    expect(flakeExitCode(flakeReport([clean]))).toBe(1);
  });
});

describe("formatFlakeReport", () => {
  it("includes the run count, stable / flaky counts, and duration stats", () => {
    const reports = [
      makeReport({ duration: 100, errorClusters: [cluster("stable", 1)] }),
      makeReport({ duration: 200, errorClusters: [cluster("stable", 1), cluster("flaky", 1)] }),
    ];
    const out = formatFlakeReport(flakeReport(reports));
    expect(out).toContain("FLAKE REPORT — 2 runs");
    expect(out).toContain("Stable clusters (fire every run): 1");
    expect(out).toContain("Flaky clusters (fire in some runs): 1");
    expect(out).toContain("Duration (ms): avg=150");
  });
});
