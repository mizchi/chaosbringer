/**
 * Every number flag of the subcommands that read theirs with `parseInt` /
 * `parseFloat` / `Number`, refused the way the main crawl refuses its own
 * (`parseNumberFlag`): a `UsageError` naming the flag, which cli.ts prints in
 * one line with exit 2. `parity --timeout 5s` was a 5 ms timeout, and the
 * aborted probes a mismatch with exit 1; `--timeout abc` and
 * `--perf-ratio abc` were NaN and the run went on as if they were not given;
 * `cluster-artifacts --min-count abc` emitted every cluster.
 *
 * In process: what cli.ts does with a `UsageError` is one row per command in
 * cli.test.ts. Each row's other arguments name files that do not exist,
 * because the numbers are checked before anything is read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseNumberFlag } from "./cli-crawl-options.js";
import { UsageError } from "./cli-usage.js";
import { runClusterArtifactsCli } from "./cluster-artifacts-cli.js";
import { writeClusterArtifacts } from "./cluster-artifacts.js";
import { runJourneyCli } from "./journey-cli.js";
import { runJourney } from "./journey.js";
import { runMinimizeCli } from "./minimize.js";
import { runParityCli } from "./parity-cli.js";
import { runParity } from "./parity.js";

// What the commands run once their flags are read, so the accepted values
// can be seen arriving. The refusals never get this far.
vi.mock("./parity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./parity.js")>()),
  runParity: vi.fn(async () => ({ pathsChecked: 1, matches: [], mismatches: [], config: {} })),
}));
vi.mock("./journey.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./journey.js")>()),
  runJourney: vi.fn(async () => ({ stepsChecked: 1, matches: [], mismatches: [] })),
}));
vi.mock("./cluster-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cluster-artifacts.js")>()),
  writeClusterArtifacts: vi.fn(() => []),
}));

type Run = (argv: string[]) => Promise<void>;
/** What a flag takes: `min` inclusive, `positive` for > 0 (0 turns the check off). */
type Bound = { min: number; integer: true } | { positive: true };

const TWO_SIDES = ["--left", "http://l.test", "--right", "http://r.test"];
const COMMANDS: Array<{ name: string; run: Run; base: string[]; flags: Record<string, Bound> }> = [
  {
    name: "parity",
    run: runParityCli,
    base: [...TWO_SIDES, "--paths", "missing-paths.txt"],
    flags: {
      "--timeout": { min: 1, integer: true },
      "--perf-samples": { min: 1, integer: true },
      "--perf-delta-ms": { positive: true },
      "--perf-ratio": { positive: true },
    },
  },
  {
    name: "journey",
    run: runJourneyCli,
    base: [...TWO_SIDES, "--steps", "missing-steps.json"],
    flags: {
      "--timeout": { min: 1, integer: true },
      "--perf-delta-ms": { positive: true },
      "--perf-ratio": { positive: true },
    },
  },
  {
    name: "cluster-artifacts",
    run: runClusterArtifactsCli,
    base: ["missing-report.json", "--bundle-dir", "missing-bundles"],
    flags: {
      // 0 emits nothing; `--min-count 0` is the default's `1`, as the main
      // crawl's --cluster-min-count takes it.
      "--max-clusters": { min: 1, integer: true },
      "--min-count": { min: 0, integer: true },
    },
  },
  {
    name: "minimize",
    run: runMinimizeCli,
    base: ["--url", "http://127.0.0.1:9/", "--trace", "missing.jsonl", "--match", "x"],
    flags: {
      "--max-pages": { min: 1, integer: true },
      "--timeout": { min: 1, integer: true },
    },
  },
];

const ALWAYS_PARSED = new Set(["--perf-samples"]);

/** The values a flag refuses, with what it says about each. */
function refusals(flag: string, bound: Bound): Array<[value: string, message: string]> {
  const rows: Array<[string, string]> = [
    ["5s", `${flag} must be a finite number (got "5s")`],
    ["abc", `${flag} must be a finite number (got "abc")`],
  ];
  // Parsed whether or not it is given, so an empty value (an unset variable
  // in `--perf-samples "$N"`) reaches the parser, where Number("") was 0.
  // The others read an empty value as not given.
  if (ALWAYS_PARSED.has(flag)) rows.push(["", `${flag} must be a finite number (got "")`]);
  if ("positive" in bound) {
    rows.push(["-1", `${flag} must be > 0 (got -1)`], ["0", `${flag} must be > 0 (got 0)`]);
  } else {
    rows.push(["1.5", `${flag} must be an integer (got 1.5)`], ["-1", `${flag} must be >= ${bound.min} (got -1)`]);
    if (bound.min > 0) rows.push(["0", `${flag} must be >= ${bound.min} (got 0)`]);
  }
  return rows;
}

const ROWS = COMMANDS.flatMap(({ name, run, base, flags }) =>
  Object.entries(flags).flatMap(([flag, bound]) =>
    refusals(flag, bound).map(([value, message]) => ({ name, run, argv: [...base, `${flag}=${value}`], message })),
  ),
);

describe("subcommand number flags", () => {
  it.each(ROWS.map((r) => [r.name, r.argv.at(-1)!, r] as const))("%s %s is a UsageError naming the flag", async (_name, _flag, row) => {
    const err = await row.run(row.argv).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toBe(row.message);
  });
});

describe("parseNumberFlag", () => {
  it("refuses an empty or blank value, which Number() reads as 0", () => {
    expect(() => parseNumberFlag("--heatmap-top", "", { min: 0 })).toThrow('--heatmap-top must be a finite number (got "")');
    expect(() => parseNumberFlag("--heatmap-top", " ", { min: 0 })).toThrow('--heatmap-top must be a finite number (got " ")');
    expect(parseNumberFlag("--heatmap-top", "0", { min: 0 })).toBe(0);
    expect(parseNumberFlag("--heatmap-top", undefined, { min: 0 })).toBeUndefined();
  });
});

// The values the bounds let through, as they reach what the command runs:
// the refusal rows above pass just as well if a parsed value is dropped on
// the way, or if a bound is tightened past a value that is meant to work
// (a --perf-ratio below 1 flags a right side that got faster).
describe("subcommand number flags that are accepted", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-numeric-accept-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(console.log).mockRestore();
  });

  it("parity passes --timeout, --perf-ratio, --perf-delta-ms and --perf-samples on", async () => {
    const paths = join(dir, "paths.txt");
    writeFileSync(paths, "/\n");
    await runParityCli([...TWO_SIDES, "--paths", paths, "--timeout", "5000", "--perf-ratio", "0.5", "--perf-delta-ms", "10", "--perf-samples", "3"]);
    expect(vi.mocked(runParity)).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 5000, perfRatio: 0.5, perfDeltaMs: 10, perfSamples: 3 }),
    );
  });

  it("journey passes --timeout, --perf-ratio and --perf-delta-ms on, and reads an empty one as not given", async () => {
    const steps = join(dir, "steps.json");
    writeFileSync(steps, JSON.stringify([{ method: "GET", path: "/" }]));
    await runJourneyCli([...TWO_SIDES, "--steps", steps, "--timeout", "5000", "--perf-ratio", "0.5", "--perf-delta-ms", "10"]);
    expect(vi.mocked(runJourney)).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 5000, perfRatio: 0.5, perfDeltaMs: 10 }),
    );
    await runJourneyCli([...TWO_SIDES, "--steps", steps, "--timeout", ""]);
    expect(vi.mocked(runJourney).mock.lastCall?.[0].timeoutMs).toBeUndefined();
  });

  it("cluster-artifacts passes --max-clusters and --min-count on, 0 included", async () => {
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify({ errorClusters: [] }));
    await runClusterArtifactsCli([report, "--bundle-dir", dir, "--max-clusters", "1", "--min-count", "0"]);
    expect(vi.mocked(writeClusterArtifacts)).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ maxClusters: 1, minCount: 0 }),
    );
  });
});
