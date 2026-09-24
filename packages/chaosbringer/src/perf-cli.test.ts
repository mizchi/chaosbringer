import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitPerfBudgets,
  formatPerfGate,
  gatePerf,
  missingKeys,
  perfGateNothingChecked,
  perfOutFromRepro,
  regressNothingMeasured,
  regressPerf,
  runPerfCli,
  splitCurrentOperands,
} from "./perf-cli.js";
import { appRun, fakeAction, fakePage, fakeReport, fakeSpan } from "./perf-fixtures.test-helpers.js";
import type { CrawlReport, PerfSpanReport } from "./types.js";

describe("emitPerfBudgets", () => {
  it("writes ceil(median × headroom) per key for lightbringer's emit metrics", () => {
    const runs = [
      appRun({ durationMs: 100, blockingMs: 10, interactionMs: 40 }),
      appRun({ durationMs: 120, blockingMs: 20, interactionMs: 60 }),
      appRun({ durationMs: 110, blockingMs: 30, interactionMs: 50 }),
    ];
    const { file, skipped, reports } = emitPerfBudgets(runs);
    expect(reports).toBe(3);
    expect(skipped).toEqual([]);
    expect(file.version).toBe(1);
    expect(file.headroom).toBe(1.25);
    expect(file.budgets["/app :: click #go"]).toEqual({
      durationMs: Math.ceil(110 * 1.25),
      scriptMs: 0,
      blockingMs: Math.ceil(20 * 1.25),
      layoutCount: 0,
      recalcStyleMs: 0,
      encodedKB: 0,
      requestCount: 0,
      interactionMs: Math.ceil(50 * 1.25),
    });
    // No interaction on the load span: no interactionMs budget for it.
    expect(file.budgets["/app :: load"]).not.toHaveProperty("interactionMs");
  });

  it("skips keys seen in fewer than half the reports, and says which", () => {
    const rare = fakeReport(
      [fakePage("http://x/app", fakeSpan("/app :: load"))],
      [fakeAction(fakeSpan("/app :: click #rare"))],
    );
    const runs = [appRun({}), appRun({}), appRun({}), rare];
    const r = emitPerfBudgets(runs, { headroom: 2 });
    expect(Object.keys(r.file.budgets).sort()).toEqual(["/app :: click #go", "/app :: load"]);
    expect(r.skipped).toEqual([{ key: "/app :: click #rare", seenIn: 1 }]);
    // exactly half is kept
    expect(Object.keys(emitPerfBudgets([appRun({}), rare]).file.budgets)).toContain("/app :: click #rare");
  });
});

describe("gatePerf", () => {
  const budgets = (b: Record<string, Record<string, number>>) =>
    Object.entries(b).map(([match, budget]) => ({ match, budget }));

  it("fails a median over budget and passes one within it", () => {
    const runs = [appRun({ blockingMs: 150 }), appRun({ blockingMs: 160 }), appRun({ blockingMs: 140 })];
    const r = gatePerf(runs, budgets({ "/app :: click #go": { blockingMs: 100, durationMs: 1000 } }));
    expect(r.violations).toEqual([{ scope: "/app :: click #go", metric: "blockingMs", median: 150, limit: 100 }]);
    expect(r.warnings).toEqual([]);
    expect(r.gatedKeys).toBe(1);
  });

  it("warns, without failing, on a noisy metric whose p75 crosses the budget", () => {
    const runs = [10, 20, 30, 40].map((b) => appRun({ blockingMs: b }));
    const r = gatePerf(runs, budgets({ "/app :: click #go": { blockingMs: 28 } }));
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([
      { scope: "/app :: click #go", metric: "blockingMs", median: 25, limit: 28, p75: 30 },
    ]);
  });

  it("applies glob rules, the tighter limit winning, and lists budgets that matched nothing", () => {
    const runs = [appRun({ durationMs: 300 }, { durationMs: 300 })];
    const r = gatePerf(runs, [
      { match: "*", budget: { durationMs: 500 } },
      { match: "* :: click *", budget: { durationMs: 200 } },
      { match: "/gone :: load", budget: { durationMs: 1 } },
    ]);
    expect(r.violations).toEqual([{ scope: "/app :: click #go", metric: "durationMs", median: 300, limit: 200 }]);
    expect(r.unmeasured).toEqual(["/gone :: load"]);
  });

  it("gates an optional metric on the sample emit-budgets used: only the spans that measured it", () => {
    // Interaction measured in 1 of 4 click spans. aggregateRuns pads the other
    // three with 0 (median 0); emit budgeted from the measured one (300).
    const measured = [300, undefined, undefined, undefined];
    const base = measured.map((i) => appRun(i === undefined ? {} : { interactionMs: i }));
    const budget = emitPerfBudgets(base).file.budgets["/app :: click #go"]!.interactionMs!;
    expect(budget).toBe(Math.ceil(300 * 1.25));
    const slow = [5000, undefined, undefined, undefined].map((i) =>
      appRun(i === undefined ? {} : { interactionMs: i }),
    );
    const r = gatePerf(slow, budgets({ "/app :: click #go": { interactionMs: budget } }));
    expect(r.violations).toEqual([
      { scope: "/app :: click #go", metric: "interactionMs", median: 5000, limit: budget },
    ]);
    expect(gatePerf(base, budgets({ "/app :: click #go": { interactionMs: budget } })).violations).toEqual([]);
  });

  it("says why when it checked nothing: no reports, no spans, no budget matched", () => {
    const rule = budgets({ "*": { durationMs: 1 } });
    expect(perfGateNothingChecked(gatePerf([], rule))).toMatch(/no crawl reports/);
    expect(perfGateNothingChecked(gatePerf([fakeReport([fakePage("http://x/")], [])], rule))).toMatch(
      /no measured spans/,
    );
    expect(perfGateNothingChecked(gatePerf([appRun({})], budgets({ "/gone :: load": { durationMs: 1 } })))).toMatch(
      /no budget matched/,
    );
    expect(perfGateNothingChecked(gatePerf([appRun({})], rule))).toBeUndefined();
    expect(formatPerfGate(gatePerf([], rule)).failed).toBe(true);
  });
});

describe("regressPerf", () => {
  it("flags a per-key regression past threshold and floor", () => {
    const base = [appRun({ blockingMs: 100 }), appRun({ blockingMs: 100 }), appRun({ blockingMs: 100 })];
    const cur = [appRun({ blockingMs: 200 }), appRun({ blockingMs: 200 }), appRun({ blockingMs: 200 })];
    const r = regressPerf(base, cur);
    expect(r.regressions.map((f) => f.subject)).toEqual(["/app :: click #go.cpu.blockingMs"]);
    expect(regressPerf(base, base).regressions).toEqual([]);
  });

  it("only warns when the current median is noisy", () => {
    const base = [100, 100, 100, 100].map((b) => appRun({ blockingMs: b }));
    const cur = [100, 200, 300, 400].map((b) => appRun({ blockingMs: b }));
    const r = regressPerf(base, cur);
    expect(r.regressions).toEqual([]);
    expect(r.warnings.map((f) => f.subject)).toEqual(["/app :: click #go.cpu.blockingMs"]);
  });

  it("lists a key with no baseline as new, not as a regression", () => {
    const cur = [
      fakeReport([], [fakeAction(fakeSpan("/app :: click #new", { blockingMs: 999 }))]),
    ];
    const r = regressPerf([appRun({})], cur);
    expect(r.regressions).toEqual([]);
    expect(r.slugs[0]!.lines).toContainEqual({ type: "new-span", span: "/app :: click #new" });
  });

  it("uses the crawl frame floors (4 frames, 17 ms), not lightbringer's defaults", () => {
    const withFrames = (droppedFrames: number, longestFrameMs: number) => {
      const run = appRun({});
      run.actions[0]!.perf = {
        ...run.actions[0]!.perf!,
        frames: { droppedFrames, longestFrameMs } as NonNullable<PerfSpanReport["frames"]>,
      };
      return run;
    };
    const base = [1, 2, 3].map(() => withFrames(0, 16.7));
    // +3 frames and one extra vsync interval: past lightbringer's 2 / 16, under the crawl floors.
    expect(regressPerf(base, [1, 2, 3].map(() => withFrames(3, 33.3))).regressions).toEqual([]);
    expect(regressPerf(base, [1, 2, 3].map(() => withFrames(5, 50))).regressions.map((f) => f.subject)).toEqual([
      "/app :: click #go.frames.droppedFrames",
      "/app :: click #go.frames.longestFrameMs",
    ]);
  });

  it("regressNothingMeasured names the side with no spans; missingKeys lists vanished keys", () => {
    const empty = fakeReport([fakePage("http://x/")], []);
    expect(regressNothingMeasured([appRun({})], [empty])).toMatch(/current report/);
    expect(regressNothingMeasured([empty], [appRun({})])).toMatch(/baseline report/);
    expect(regressNothingMeasured([appRun({})], [appRun({})])).toBeUndefined();
    const loadOnly = fakeReport([fakePage("http://localhost:3000/app", fakeSpan("/app :: load"))], []);
    expect(missingKeys([appRun({})], [loadOnly])).toEqual(["/app :: click #go"]);
  });
});

describe("argument helpers", () => {
  it("splitCurrentOperands takes every operand after --current up to the next flag", () => {
    expect(splitCurrentOperands(["base/", "--current", "a.json", "b.json", "--threshold", "0.2"])).toEqual({
      rest: ["base/", "--threshold", "0.2"],
      current: ["a.json", "b.json"],
    });
    expect(splitCurrentOperands(["b.json", "--current=c.json"])).toEqual({ rest: ["b.json"], current: ["c.json"] });
  });

  it("perfOutFromRepro reads --perf-out, quoted or not", () => {
    expect(perfOutFromRepro("chaosbringer --url x --perf-out perf-dir")).toBe("perf-dir");
    expect(perfOutFromRepro("chaosbringer --perf-out 'my dir' --seed 1")).toBe("my dir");
    expect(perfOutFromRepro("chaosbringer --perf")).toBeUndefined();
    expect(perfOutFromRepro(undefined)).toBeUndefined();
  });
});

describe("runPerfCli", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const logged = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  const errored = () => errSpy.mock.calls.map((c: unknown[]) => String(c.join(" "))).join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-perf-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  function write(name: string, value: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(value));
    return p;
  }

  it("prints help with no subcommand and fails on an unknown one", async () => {
    await runPerfCli([]);
    expect(logged()).toContain("emit-budgets");
    await runPerfCli(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('unknown subcommand "frobnicate"');
  });

  it("emit-budgets writes the file, then gate passes the same runs and fails a slower one", async () => {
    const runs = [1, 2, 3].map((i) => write(`r${i}.json`, appRun({ blockingMs: 10 + i })));
    const out = join(dir, "budgets.json");
    await runPerfCli(["emit-budgets", ...runs, "--headroom", "1.5", "--out", out]);
    expect(process.exitCode).toBe(0);
    const file = JSON.parse(readFileSync(out, "utf-8"));
    expect(file).toMatchObject({ version: 1, headroom: 1.5 });
    expect(file.budgets["/app :: click #go"].blockingMs).toBe(Math.ceil(12 * 1.5));
    expect(logged()).toContain("2 key(s) from 3 report(s)");

    await runPerfCli(["gate", ...runs, "--budgets", out]);
    expect(process.exitCode).toBe(0);
    expect(logged()).toContain("[perf gate] passed");

    const slow = write("slow.json", appRun({ blockingMs: 160 }));
    await runPerfCli(["gate", slow, "--budgets", out]);
    expect(process.exitCode).toBe(1);
    expect(logged()).toContain("✗ /app :: click #go  blockingMs median=160 > budget 18");
    expect(errored()).toContain("[perf gate] FAILED: 1 violation(s)");
  });

  it("emit-budgets logs the skipped keys", async () => {
    const rare = fakeReport([], [fakeAction(fakeSpan("/x :: click #rare"))]);
    const paths = [write("a.json", appRun({})), write("b.json", appRun({})), write("c.json", appRun({})), write("d.json", rare)];
    await runPerfCli(["emit-budgets", ...paths, "--out", join(dir, "o.json")]);
    expect(logged()).toContain("skipped 1 key(s) seen in fewer than half the reports");
    expect(logged()).toContain("/x :: click #rare  (1/4)");
  });

  it("gate --json reports violations and passed=false", async () => {
    const b = write("b.json", [{ match: "* :: click *", budget: { blockingMs: 5 } }]);
    await runPerfCli(["gate", write("r.json", appRun({ blockingMs: 50 })), "--budgets", b, "--json"]);
    expect(process.exitCode).toBe(1);
    const out = JSON.parse(logged());
    expect(out.passed).toBe(false);
    expect(out.violations).toHaveLength(1);
  });

  it("gate and emit-budgets refuse missing arguments", async () => {
    await runPerfCli(["gate", "r.json"]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("--budgets <file> is required");
    process.exitCode = 0;
    await runPerfCli(["emit-budgets"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await expect(runPerfCli(["emit-budgets", write("x.json", {}), "--out", join(dir, "o.json")])).rejects.toThrow(
      /not a chaosbringer crawl report/,
    );
    await expect(runPerfCli(["emit-budgets", write("y.json", appRun({})), "--headroom", "0.5"])).rejects.toThrow(
      /--headroom must be a number >= 1/,
    );
  });

  it("regress reads a baseline directory (skipping non-report JSON) and exits 1 on a regression", async () => {
    const baseDir = join(dir, "baseline");
    mkdirSync(baseDir);
    for (const i of [1, 2, 3]) writeFileSync(join(baseDir, `r${i}.json`), JSON.stringify(appRun({ blockingMs: 100 })));
    writeFileSync(join(baseDir, "chaosbringer.perf-budgets.json"), JSON.stringify({ version: 1, budgets: {} }));
    const cur = [1, 2, 3].map((i) => write(`c${i}.json`, appRun({ blockingMs: 250 })));

    await runPerfCli(["regress", baseDir, "--current", ...cur]);
    expect(process.exitCode).toBe(1);
    expect(logged()).toContain("skipped 1 non-report JSON file(s)");
    expect(errored()).toContain("/app :: click #go.cpu.blockingMs 100 → 250");

    process.exitCode = 0;
    await runPerfCli(["regress", baseDir, "--current", join(baseDir, "r1.json")]);
    expect(process.exitCode).toBe(0);

    await runPerfCli(["regress", baseDir]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("--current <report.json...> is required");
  });

  it("regress fails when the current side has no reports or no spans, and lists vanished keys", async () => {
    const baseDir = join(dir, "baseline");
    const emptyDir = join(dir, "empty");
    mkdirSync(baseDir);
    mkdirSync(emptyDir);
    for (const i of [1, 2, 3]) writeFileSync(join(baseDir, `r${i}.json`), JSON.stringify(appRun({})));

    await runPerfCli(["regress", baseDir, "--current", emptyDir]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("no crawl reports in --current");

    process.exitCode = 0;
    const unmeasured = write("u.json", fakeReport([fakePage("http://localhost:3000/app")], []));
    await runPerfCli(["regress", baseDir, "--current", unmeasured]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("no measured spans in the 1 current report(s)");

    process.exitCode = 0;
    const loadOnly = write(
      "l.json",
      fakeReport([fakePage("http://localhost:3000/app", fakeSpan("/app :: load"))], []),
    );
    await runPerfCli(["regress", baseDir, "--current", loadOnly]);
    expect(process.exitCode).toBe(0);
    expect(logged()).toContain("1 baseline key(s) not measured in current");
  });

  it("gate fails on an empty report set, reports without spans, or budgets that match nothing", async () => {
    const b = write("b.json", { version: 1, budgets: { "/app :: click #go": { durationMs: 1000 } } });
    const emptyDir = join(dir, "empty");
    mkdirSync(emptyDir);
    await runPerfCli(["gate", emptyDir, "--budgets", b]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("[perf gate] FAILED: no crawl reports to gate");

    process.exitCode = 0;
    await runPerfCli(["gate", write("u.json", fakeReport([fakePage("http://x/")], [])), "--budgets", b, "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logSpy.mock.calls.at(-1)![0] as string).passed).toBe(false);

    process.exitCode = 0;
    const other = write("o.json", { version: 1, budgets: { "/gone :: load": { durationMs: 1 } } });
    await runPerfCli(["gate", write("r.json", appRun({})), "--budgets", other]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("no budget matched any measured span");
  });

  it("gate refuses a budgets file the crawler would refuse (misspelt metric)", async () => {
    const b = write("b.json", [{ match: "*", budget: { durationMS: 1 } }]);
    await runPerfCli(["gate", write("r.json", appRun({})), "--budgets", b]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toMatch(/durationMS" is not a budget metric/);
  });

  it("emit-budgets with nothing to budget fails without overwriting the existing file", async () => {
    const out = write("budgets.json", { version: 1, headroom: 1.25, budgets: { "/app :: load": { durationMs: 50 } } });
    const before = readFileSync(out, "utf-8");
    await runPerfCli(["emit-budgets", write("u.json", fakeReport([fakePage("http://x/")], [])), "--out", out]);
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain("left untouched");
    expect(readFileSync(out, "utf-8")).toBe(before);
  });

  describe("drilldown", () => {
    const KEY = "/app :: click #go";

    function tracedRun(opts: { reportPath?: string; tracePath?: string; perfOut?: string }): CrawlReport {
      const click = { ...fakeSpan(KEY, { durationMs: 200, blockingMs: 120 }), traceWindowUs: [1000, 300000] as [number, number] };
      const page = fakePage("http://localhost:3000/app", fakeSpan("/app :: load"), {
        ...(opts.reportPath
          ? {
              perfPage: {
                vitals: {},
                network: { totalRequests: 0, totalEncodedKB: 0, fromCacheCount: 0 },
                reportPath: opts.reportPath,
              },
            }
          : {}),
      });
      return fakeReport([page], [fakeAction(click)], {
        reproCommand: `chaosbringer --url http://localhost:3000/app --seed 1${opts.perfOut ? ` --perf-out ${opts.perfOut}` : ""}`,
      });
    }

    it("explains when the crawl wrote no per-page report", async () => {
      const r = write("r.json", tracedRun({}));
      await expect(runPerfCli(["drilldown", r, KEY])).rejects.toThrow(/rerun the crawl with --perf-trace/);
    });

    it("lists the keys when the key is unknown", async () => {
      const r = write("r.json", tracedRun({}));
      await expect(runPerfCli(["drilldown", r, "/nope :: load"])).rejects.toThrow(/Keys:\n {2}\/app :: click #go/);
    });

    it("explains when the page was measured without a trace", async () => {
      const perfOut = join(dir, "perf");
      mkdirSync(perfOut);
      writeFileSync(
        join(perfOut, "p.json"),
        JSON.stringify({ url: "http://localhost:3000/app", spans: [{ ...fakeSpan(KEY), traceWindowUs: [0, 1] }] }),
      );
      const r = write("r.json", tracedRun({ reportPath: "p.json", perfOut }));
      await expect(runPerfCli(["drilldown", r, KEY])).rejects.toThrow(/measured without a trace — rerun the crawl with --perf-trace/);
    });

    it("finds the sidecar through the repro's --perf-out and drills into the trace window", async () => {
      const perfOut = join(dir, "perf");
      mkdirSync(perfOut);
      const tracePath = join(perfOut, "p.trace.json");
      writeFileSync(
        tracePath,
        JSON.stringify([
          { name: "RunTask", ph: "X", ts: 2000, dur: 120000 },
          { name: "FunctionCall", ph: "X", ts: 2100, dur: 110000, args: { data: { functionName: "spin", url: "http://localhost:3000/app", lineNumber: 3 } } },
          { name: "RunTask", ph: "X", ts: 900000, dur: 50000 }, // outside the window
        ]),
      );
      writeFileSync(
        join(perfOut, "p.json"),
        JSON.stringify({
          url: "http://localhost:3000/app",
          tracePath,
          spans: [{ ...fakeSpan(KEY, { durationMs: 200, blockingMs: 120 }), traceWindowUs: [1000, 300000] }],
        }),
      );
      const r = write("r.json", tracedRun({ reportPath: "p.json", perfOut }));
      await runPerfCli(["drilldown", r, KEY, "--top", "5"]);
      expect(process.exitCode).toBe(0);
      const out = logged();
      expect(out).toContain(`span "${KEY}"`);
      expect(out).toContain("RunTask total 120ms / 1 tasks");
    });

    it("refuses a wrong operand count", async () => {
      await runPerfCli(["drilldown", "r.json"]);
      expect(process.exitCode).toBe(1);
      expect(errored()).toContain("expected <report.json> <perfKey>");
    });
  });
});
