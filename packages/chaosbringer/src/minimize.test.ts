import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { REPLAY_CRAWL_FLAGS, REPLAY_REFUSED_FLAGS } from "./cli-crawl-options.js";
import { UsageError } from "./cli-usage.js";
import { checkReplayFiles, ddmin, minimizeActions, parseMinimizeArgs, replaySetup, reportMatches, traceWithActions } from "./minimize.js";
import { formatReproFlags } from "./repro-command.js";
import { cliOptions, ROUND_TRIPS, URL } from "./repro-flags.test-helpers.js";
import {
  TRACE_FORMAT_VERSION,
  traceSetupOf,
  type TraceAction,
  type TraceEntry,
  type TraceMeta,
} from "./trace.js";
import type { CrawlerOptions, CrawlReport, PageError } from "./types.js";

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

  it("numbers ddmin's progress by replay, counting the full and empty replays", async () => {
    const steps: number[] = [];
    let replays = 0;
    await minimizeActions(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (s) => {
        replays++;
        return s.includes(3);
      },
      (info) => steps.push(info.iteration),
    );
    // Each reported iteration is the replay that kept the subset, so the last
    // one is never later than the total.
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toBeGreaterThan(2);
    expect(Math.max(...steps)).toBeLessThanOrEqual(replays);
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

describe("minimize CLI arguments", () => {
  const base = ["--trace", "t.jsonl", "--match", "boom"];

  // `minimize --storage-state` exited 2 as an unknown option, so a failure
  // behind a login could not be minimized at all.
  it("takes the crawl flags that shape a replay", () => {
    const args = parseMinimizeArgs([
      ...base, "--storage-state", "s.json", "--settle", "adaptive", "--exclude", "/logout", "--ignore-preset", "analytics",
      "--device", "Pixel 7", "--network", "fast-3g", "--no-headless", "--timeout", "5000", "--har-replay", "h.har",
      "--spa", "/app", "--no-http-cache", "--invariants", "data-safety", "--ignore-error", "x", "--ignore-analytics",
    ]);
    expect([...args.replayGiven].sort()).toEqual([
      "device", "exclude", "har-replay", "ignore-analytics", "ignore-error", "ignore-preset", "invariants", "network",
      "no-headless", "no-http-cache", "settle", "spa", "storage-state", "timeout",
    ]);
  });

  it("defaults --url to the trace's and keeps its own flags", () => {
    expect(parseMinimizeArgs(base)).toMatchObject({ url: undefined, traceOut: "min.trace.jsonl", quiet: false, maxPagesGiven: false });
    expect(parseMinimizeArgs([...base, "--url", "http://y/", "--max-pages", "3"])).toMatchObject({ url: "http://y/", maxPagesGiven: true });
  });

  it("refuses a flag the trace decides, saying why", () => {
    expect(() => parseMinimizeArgs([...base, "--seed", "3"])).toThrow(
      "--seed does not apply to minimize: the trace decides the actions, so there is no random choice for a seed to make",
    );
    expect(() => parseMinimizeArgs([...base, "--strict"])).toThrow(
      "--strict does not apply to minimize: --match decides whether a replay reproduced, not the exit rules",
    );
  });

  it("refuses a pasted crawl command, and a misspelled flag by the one it misses", () => {
    expect(() => parseMinimizeArgs([...base, "--", "chaosbringer", "--url", "http://x/"])).toThrow(
      /minimize takes no crawl command after --/,
    );
    expect(() => parseMinimizeArgs([...base, "--storage-stat", "s.json"])).toThrow(
      "unknown option --storage-stat: did you mean --storage-state?",
    );
  });

  it("refuses a stray argument instead of dropping it, a bare URL with the --url spelling", () => {
    expect(() => parseMinimizeArgs([...base, "http://y/"])).toThrow(
      new UsageError('unexpected argument "http://y/": give the URL to replay against as --url http://y/'),
    );
    expect(() => parseMinimizeArgs(["extra", ...base])).toThrow(
      new UsageError('unexpected argument "extra": minimize takes flags only (--trace <file> --match <regex>, and --url <url>)'),
    );
  });

  it("refuses a value the crawl refuses, before the trace is read", () => {
    expect(() => parseMinimizeArgs([...base, "--settle", "slow"])).toThrow(UsageError);
    expect(() => parseMinimizeArgs([...base, "--exclude", "("])).toThrow(/--exclude "\(" is not a valid regex/);
  });

  // Every flag a Repro: line can carry: taken, or refused with why.
  it.each(Object.entries(ROUND_TRIPS))("--%s from a Repro: line is applied, or refused with a reason", (flag, argv) => {
    const replayFlags: readonly string[] = REPLAY_CRAWL_FLAGS;
    const own = ["url", "max-pages", "trace-out"];
    const refused = argv.flatMap((a) => {
      const name = a.replace(/^--/, "").split("=")[0]!;
      return name in REPLAY_REFUSED_FLAGS ? [name] : [];
    });
    if (refused.length === 0) {
      expect(replayFlags.includes(flag) || own.includes(flag)).toBe(true);
      expect(() => parseMinimizeArgs([...base, ...argv])).not.toThrow();
    } else {
      expect(replayFlags.includes(flag)).toBe(false);
      expect(() => parseMinimizeArgs([...base, ...argv])).toThrow(
        new RegExp(`^--(${refused.join("|")}) does not apply to minimize: `),
      );
    }
  });
});

describe("replaySetup", () => {
  const recorded = traceSetupOf(
    cliOptions(["--url", URL, "--storage-state", "s.json", "--settle", "adaptive", "--ignore-preset", "analytics", "--data-safety"]),
  );
  const run = (argv: string[]) => replaySetup(recorded, parseMinimizeArgs(["--trace", "t", "--match", "x", ...argv]), URL);
  /** What is set: a subset table leaves a boolean `undefined` where the main crawl's defaults it to `false`. */
  const set = (o: CrawlerOptions) =>
    Object.fromEntries(
      Object.entries(o)
        .filter(([, v]) => v !== undefined && v !== false)
        .map(([k, v]) => [k, k === "invariants" ? (v as CrawlerOptions["invariants"])!.map((i) => i.name) : v]),
    );

  it("replays with what the trace recorded", () => {
    const setup = run([]);
    expect(set(setup.options)).toEqual(
      set(cliOptions(["--url", URL, "--settle", "adaptive", "--ignore-preset", "analytics", "--storage-state", "s.json", "--invariants", "data-safety"])),
    );
    expect(formatReproFlags(setup.applied)).toEqual([
      "--settle", "adaptive", "--ignore-preset", "analytics", "--storage-state", "s.json", "--invariants", "data-safety",
    ]);
    expect(setup.overridden).toEqual([]);
  });

  it("lets a flag replace what was recorded for its setting, and only that", () => {
    const setup = run(["--storage-state", "other.json", "--ignore-error", "noise", "--invariants", "not-blank"]);
    expect(setup.options.storageState).toBe("other.json");
    // The recorded preset is replaced, not added to.
    expect(setup.options.ignoreErrorPatterns).toEqual(["noise"]);
    expect(setup.options.invariants?.map((i) => i.name)).toEqual(["data.not-blank"]);
    expect(setup.options.settle).toBe("adaptive");
    expect(setup.overridden).toEqual(["--ignore-error", "--storage-state", "--invariants"]);
  });

  // As one of the invariants flags, `--axe-tags` replaced the recorded
  // `--axe` and `--invariants` with itself, which builds nothing.
  it("lets --axe-tags alone retag the recorded axe check, keeping the recorded invariants", () => {
    const withAxe = traceSetupOf(cliOptions(["--url", URL, "--axe", "--invariants", "data-safety"]));
    const setup = replaySetup(withAxe, parseMinimizeArgs(["--trace", "t", "--match", "x", "--axe-tags", "wcag2a"]), URL);
    const names = setup.options.invariants?.map((i) => i.name) ?? [];
    expect(names).toEqual(cliOptions(["--url", URL, "--axe", "--invariants", "data-safety"]).invariants?.map((i) => i.name));
    expect(names.length).toBeGreaterThan(1);
    expect(setup.values["axe-tags"]).toBe("wcag2a");
    expect(formatReproFlags(setup.applied)).toEqual(["--invariants", "data-safety", "--axe"]);
    expect(setup.overridden).toEqual([]);
    // A recorded --axe-tags is the one replaced.
    const tagged = traceSetupOf(cliOptions(["--url", URL, "--axe", "--axe-tags", "wcag21a"]));
    const retagged = replaySetup(tagged, parseMinimizeArgs(["--trace", "t", "--match", "x", "--axe-tags", "wcag2a"]), URL);
    expect(retagged.values["axe-tags"]).toBe("wcag2a");
    expect(retagged.overridden).toEqual(["--axe-tags"]);
  });

  it("refuses --axe-tags alone when the trace recorded no axe check", () => {
    expect(() => run(["--axe-tags", "wcag2a"])).toThrow(
      "--axe-tags without --axe: the trace recorded no axe check for it to tag; give --axe --axe-tags <list>",
    );
    // With --axe it replaces the recorded invariants, as documented.
    expect(run(["--axe", "--axe-tags", "wcag2a"]).overridden).toEqual(["--invariants"]);
  });

  it("replays a v1 trace, which records nothing, with the defaults and the flags", () => {
    const setup = replaySetup(undefined, parseMinimizeArgs(["--trace", "t", "--match", "x", "--storage-state", "s.json"]), URL);
    expect(set(setup.options)).toEqual(set(cliOptions(["--url", URL, "--storage-state", "s.json"])));
    expect(setup.applied).toEqual([]);
  });
});

describe("checkReplayFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "chaos-min-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing.json");

  // The refusal named a flag the user never gave, and nothing said the path
  // came from the trace or that a flag replaces it.
  it("says a missing file came from the trace's setup, and which flag replaces it", () => {
    expect(() => checkReplayFiles({ storageState: missing }, new Set())).toThrow(
      `--storage-state ${missing}: no such file (recorded in the trace's setup, read from the current directory; give --storage-state <path> to replace it)`,
    );
    expect(() => checkReplayFiles({ har: { path: missing, mode: "replay" } }, new Set())).toThrow(
      /^--har-replay .*: no such file \(recorded in the trace's setup, .*give --har-replay <path> to replace it\)$/,
    );
  });

  it("refuses a file given as a flag as the crawl does", () => {
    expect(() => checkReplayFiles({ storageState: missing }, new Set(["storage-state"]))).toThrow(
      new RegExp(`^--storage-state ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: no such file$`),
    );
    const ok = join(dir, "s.json");
    writeFileSync(ok, JSON.stringify({ cookies: [], origins: [] }));
    expect(() => checkReplayFiles({ storageState: ok }, new Set())).not.toThrow();
  });
});
