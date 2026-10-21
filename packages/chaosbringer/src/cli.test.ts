/**
 * The main CLI as a user meets it, run as a process: `cli.ts` parses
 * `process.argv` and exits as soon as it is imported. None of these get as
 * far as starting a browser.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import { progressText, SUBCOMMANDS } from "./cli-usage.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** Nothing listens here; a crawl that got this far would fail, not hang. */
const URL_ARG = ["--url", "http://127.0.0.1:9/"];

function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Async, so `it.concurrent` rows run side by side: each spawn compiles the CLI with tsx. */
function cliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 60_000 },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("--help", () => {
  it("lists every subcommand of the dispatch table, one line each with its summary", () => {
    const r = cli(["-h"]);
    expect(r.status).toBe(0);
    const section = r.stdout.split("\nSUBCOMMANDS")[1]?.split("\n\n")[0] ?? "";
    const rows = section.split("\n").slice(1);
    expect(rows.map((row) => row.trim().split(/\s+/)[0])).toEqual(Object.keys(SUBCOMMANDS));
    for (const [name, sub] of Object.entries(SUBCOMMANDS)) {
      expect(rows).toContainEqual(expect.stringMatching(new RegExp(`^  ${name} +${escapeRegExp(sub.summary)}$`)));
    }
  });
});

describe("--help on --strict", () => {
  it("names all three kinds it fails on", () => {
    // It said "any console errors"; JS exceptions and unhandled rejections fail it too.
    const line = cli(["-h"]).stdout.split("\n").find((l) => l.trimStart().startsWith("--strict "));
    expect(line).toBe("  --strict              Fail on console errors, JS exceptions and unhandled rejections");
  });
});

describe("--version", () => {
  it.each([["--version"], ["-V"]])("%s prints the package.json version and exits 0", (flag) => {
    const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
    const r = cli([flag]);
    expect(r.stdout).toBe(`${version}\n`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("progressText", () => {
  it("redraws one line on a terminal, and writes a line per page anywhere else", () => {
    expect(progressText(2, 5, true)).toBe("\rProgress: 2/5 pages");
    expect(progressText(2, 5, false)).toBe("Progress: 2/5 pages\n");
  });
});

describe("usage errors", () => {
  it.each([
    [["--max-page", "3"], "unknown option --max-page"],
    [["-x"], "unknown option -x"],
    [[...URL_ARG, "--max-pages", "abc"], '--max-pages must be a finite number (got "abc")'],
    [[...URL_ARG, "--max-pages", "0"], "--max-pages must be >= 1 (got 0)"],
    [[...URL_ARG, "--timeout", "5s"], '--timeout must be a finite number (got "5s")'],
    // Refused by validateOptions, which used to throw from inside main().
    [[...URL_ARG, "--cdp-target", "x"], '"cdpTargetId" requires "cdpEndpoint"'],
    [[], "--url is required"],
    // A Repro: line's `# + …` note, pasted into a zsh without interactivecomments.
    [
      [...URL_ARG, "#", "+", "1", "fault", "rule", "not", "expressible", "on", "the", "CLI:", "api-500"],
      'unexpected argument "#": the shell passed a comment on as arguments (zsh does without ' +
        "`setopt interactivecomments`); drop the `#` and everything after it",
    ],
  ])("%j is one line on stderr and exit 2, before anything runs", (args, message) => {
    const r = cli(args);
    expect(r.stderr.trimEnd().split("\n")).toEqual([`chaosbringer: ${message} (see chaosbringer --help)`]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(2);
  });

  it("folds a refusal parseArgs words over several lines into the one line", () => {
    const r = cli([...URL_ARG, "--timeout", "-5"]);
    expect(r.stderr.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^chaosbringer: Option '--timeout' argument is ambiguous\. .*'--timeout=-XYZ'\. \(see chaosbringer --help\)$/),
    ]);
    expect(r.status).toBe(2);
  });

  it("refuses --perf-budgets emitted under another settle mode in one chaosbringer: line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-budgets-"));
    try {
      const file = join(dir, "budgets.json");
      writeFileSync(file, JSON.stringify({ version: 1, budgets: {}, settle: { mode: "adaptive", quietMs: 500 } }));
      const r = cli([...URL_ARG, "--perf-budgets", file]);
      expect(r.stderr.trimEnd().split("\n")).toEqual([
        expect.stringMatching(new RegExp(`^chaosbringer: --perf-budgets ${escapeRegExp(file)}: refusing to enforce: .*--allow-settle-mismatch`)),
      ]);
      expect(r.stdout).toBe("");
      expect(r.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The subcommands' own refusals: they printed `<sub> failed: Unknown option
  // '--bogus'. To specify a positional …` and exited 1, which a CI step reads
  // as "the run found something", and the README promised 2. One row per
  // subcommand, and per sub of recipes / model / perf, for the unknown flag,
  // plus the refusals each makes of its own arguments.
  const RECIPES_SUBS = ["list", "show", "history", "promote", "demote", "delete", "prune", "rollback", "harvest", "verify", "diff", "lint", "repair"];
  const MODEL_SUBS = ["calibrate", "compile", "run", "shrink"];
  const PERF_SUBS = ["emit-budgets", "gate", "regress", "drilldown"];
  const subRows: Array<[argv: string[], command: string, message: string]> = [
    ...Object.keys(SUBCOMMANDS)
      .filter((name) => !["recipes", "model", "perf", "shard"].includes(name))
      .map((name): [string[], string, string] => [[name, "--bogus"], name, "unknown option --bogus"]),
    ...RECIPES_SUBS.map((sub): [string[], string, string] => [["recipes", sub, "--bogus"], `recipes ${sub}`, "unknown option --bogus"]),
    ...MODEL_SUBS.map((sub): [string[], string, string] => [["model", sub, "--bogus"], `model ${sub}`, "unknown option --bogus"]),
    ...PERF_SUBS.map((sub): [string[], string, string] => [["perf", sub, "--bogus"], `perf ${sub}`, "unknown option --bogus"]),
    // shard checks what it forwards against the main crawl's flags, once,
    // instead of letting each of N workers refuse it.
    [["shard", "--count", "2", ...URL_ARG, "--bogus"], "shard", "unknown option --bogus"],
    [["shard", "--count", "2", ...URL_ARG, "--max-pages", "abc"], "shard", '--max-pages must be a finite number (got "abc")'],
    // The main CLI's own checks past the crawler's options: each worker
    // refused these, and the run ended in "no reports produced" and exit 1.
    [["shard", "--count", "2", ...URL_ARG, "--heatmap-top", "abc"], "shard", '--heatmap-top must be a finite number (got "abc")'],
    [
      ["shard", "--count", "2", ...URL_ARG, "--cluster-artifacts"],
      "shard",
      "--cluster-artifacts requires --failure-artifacts <dir>: it copies from the per-page bundles",
    ],
    [
      ["shard", "--count", "2", ...URL_ARG, "--perf-budgets", "missing-budgets.json"],
      "shard",
      "ENOENT: no such file or directory, open 'missing-budgets.json'",
    ],
    [["shard", "--count", "2"], "shard", "--url is required"],
    [["shard", ...URL_ARG], "shard", "--count <N> is required and must be an integer >= 1"],
    [["recipes", "frob"], "recipes", `unknown subcommand "frob" (expected ${RECIPES_SUBS.join(", ")})`],
    [["model", "frob"], "model", 'unknown command "frob" (expected calibrate, compile, run or shrink)'],
    [["perf", "frob"], "perf", 'unknown subcommand "frob" (expected emit-budgets, gate, regress or drilldown)'],
    // Missing operands, missing required flags, malformed values.
    [["scan"], "scan", "--url is required"],
    [["scan", ...URL_ARG, "--max-pages", "abc"], "scan", '--max-pages must be an integer >= 1 (got "abc")'],
    // A chaos report's reproCommand with its `# + …` note, pasted into a zsh
    // without interactivecomments: parseArgs' "Unexpected argument '#'. This
    // command does not take positional arguments" did not say to drop it.
    [
      ["scan", ...URL_ARG, "--seed", "7", "--faults", "abort", "#", "+", "1", "invariant", "not", "expressible", "on", "the", "CLI:", "cart-total"],
      "scan",
      'unexpected argument "#": the shell passed a comment on as arguments (zsh does without ' +
        "`setopt interactivecomments`); drop the `#` and everything after it",
    ],
    [["scan", ...URL_ARG, "crawl"], "scan", 'unexpected argument "crawl": scan takes no positional arguments'],
    [["flake"], "flake", "--url is required"],
    [["flake", ...URL_ARG, "--runs", "1"], "flake", '--runs must be an integer >= 2 (got "1")'],
    // These started Run 1/3 and failed inside the crawler with exit 1, which
    // chaos-flake.yml reads as "flakes were found".
    [["flake", ...URL_ARG, "--max-pages", "abc"], "flake", '--max-pages must be a finite number (got "abc")'],
    [["flake", ...URL_ARG, "--max-actions-per-page", "1.5"], "flake", "--max-actions-per-page must be an integer (got 1.5)"],
    [["flake", ...URL_ARG, "--timeout", "5s"], "flake", '--timeout must be a finite number (got "5s")'],
    [["minimize"], "minimize", "--url is required"],
    [["diff", "a.json"], "diff", "expected exactly two report paths, got 1"],
    [["cluster-artifacts", "r.json"], "cluster-artifacts", "--bundle-dir is required"],
    [["parity", "--left", "http://a.test"], "parity", "--left, --right, and --paths are all required"],
    [["journey"], "journey", "--left, --right, and --steps are all required"],
    [["load"], "load", "--base-url is required"],
    [["load", "--base-url", "http://a.test", "--workers", "abc"], "load", "--workers must be a positive integer, got abc"],
    [["drive"], "drive", "--url and --goal are required"],
    [["recipes", "show"], "recipes show", "expected a recipe name"],
    [["recipes", "rollback", "x"], "recipes rollback", "--to-version N is required"],
    [["recipes", "verify", "x", "--base-url", "staging.test"], "recipes verify", '--base-url must be an absolute http(s) URL, got "staging.test"'],
    // An empty value (an unset variable in `--min-success-rate "$RATE"`) was
    // read as 0, which promotes the recipe whatever its success rate.
    [
      ["recipes", "verify", "x", "--base-url", "http://a.test", "--min-success-rate", ""],
      "recipes verify",
      '--min-success-rate must be a number in 0..1, got ""',
    ],
    [["model", "compile"], "model compile", "--traces, --out are required"],
    [["model", "shrink", "--plan", "p", ...URL_ARG, "--config", "c", "--max-runs", "0"], "model shrink", '--max-runs needs a positive integer, got "0"'],
    [["perf", "gate", "r.json"], "perf gate", "--budgets <file> is required"],
    [["perf", "regress", "base/"], "perf regress", "--current <report.json...> is required"],
  ];

  it("has a row for every subcommand", () => {
    expect(new Set(subRows.map(([argv]) => argv[0]))).toEqual(new Set(Object.keys(SUBCOMMANDS)));
  });

  it.concurrent.each(subRows)("%j is one `chaosbringer %s:` line on stderr and exit 2", async (args, command, message) => {
    const r = await cliAsync(args);
    expect(r.stderr.trimEnd().split("\n")).toEqual([
      `chaosbringer ${command}: ${message} (see chaosbringer ${command} --help)`,
    ]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(2);
  });

  it("keeps a run that failed on its input as `<sub> failed:` and exit 1", async () => {
    const r = await cliAsync(["diff", "missing-left.json", "missing-right.json"]);
    expect(r.stderr).toMatch(/^diff failed: failed to read missing-left\.json: ENOENT/);
    expect(r.status).toBe(1);
  });

  it("names the flag for a malformed number, where parseInt read a prefix of it", () => {
    const options = (argv: string[]) => crawlerOptionsFromCli(parseCrawlArgs(argv).values, "http://x.test/");
    expect(() => options(["--max-pages", "3x"])).toThrow("--max-pages must be a finite number");
    expect(() => options(["--max-actions-per-page", "1.5"])).toThrow("--max-actions-per-page must be an integer");
    expect(options(["--max-pages", "3", "--max-actions", "0", "--timeout", "5000"])).toMatchObject({
      maxPages: 3,
      maxActionsPerPage: 0,
      timeout: 5000,
    });
  });
});
