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
import { describe, expect, it } from "vitest";
import { UsageError } from "./cli-usage.js";
import { runClusterArtifactsCli } from "./cluster-artifacts-cli.js";
import { runJourneyCli } from "./journey-cli.js";
import { runMinimizeCli } from "./minimize.js";
import { runParityCli } from "./parity-cli.js";

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

/** The values a flag refuses, with what it says about each. */
function refusals(flag: string, bound: Bound): Array<[value: string, message: string]> {
  const rows: Array<[string, string]> = [
    ["5s", `${flag} must be a finite number (got "5s")`],
    ["abc", `${flag} must be a finite number (got "abc")`],
  ];
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
