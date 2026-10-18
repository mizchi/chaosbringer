/**
 * What the main CLI says about itself rather than about a run: the
 * subcommand table behind `--help`, `--version`, usage errors and the
 * `--compact` progress line.
 *
 * Out of `cli.ts`, which parses `process.argv` and exits as soon as it is
 * imported, so a test can read the table: `--help` listed 3 of the 13
 * subcommands, and the other ten could only be found in the source.
 */
import { readFileSync } from "node:fs";

export interface Subcommand {
  /** Its line in the SUBCOMMANDS section of `chaosbringer --help`. */
  summary: string;
  /**
   * Lazy-imports the handler, so a `chaosbringer --help` invocation doesn't
   * pay the cost of compiling every subcommand.
   */
  load: () => Promise<(argv: string[]) => Promise<void>>;
}

export const SUBCOMMANDS: Record<string, Subcommand> = {
  minimize: {
    summary: "Shrink a recorded trace to the fewest actions that still reproduce a failure",
    load: () => import("./minimize.js").then((m) => m.runMinimizeCli),
  },
  flake: {
    summary: "Run the same crawl N times and report the errors that fire on only some runs",
    load: () => import("./flake.js").then((m) => m.runFlakeCli),
  },
  shard: {
    summary: "Run N crawlers in parallel, each on its share of the URLs, and merge their reports",
    load: () => import("./shard.js").then((m) => m.runShardCli),
  },
  recipes: {
    summary: "Manage the recipe store: list, show, harvest, verify, promote, repair recipes",
    load: () => import("./recipes/cli.js").then((m) => m.runRecipesCli),
  },
  load: {
    summary: "Replay verified recipes from the store with N concurrent workers for a duration",
    load: () => import("./recipes/load-cli.js").then((m) => m.runLoadCli),
  },
  diff: {
    summary: "Compare two crawl reports: clusters only on the left, only on the right, on both",
    load: () => import("./diff-cli.js").then((m) => m.runDiffCli),
  },
  "cluster-artifacts": {
    summary: "Write one failure bundle per error cluster of a report, from its per-page bundles",
    load: () => import("./cluster-artifacts-cli.js").then((m) => m.runClusterArtifactsCli),
  },
  parity: {
    summary: "GET the same paths on two base URLs and report status / redirect mismatches",
    load: () => import("./parity-cli.js").then((m) => m.runParityCli),
  },
  journey: {
    summary: "Replay a sequence of HTTP requests on two base URLs and compare each step",
    load: () => import("./journey-cli.js").then((m) => m.runJourneyCli),
  },
  model: {
    summary: "Model-driven faults: compile model traces into plans, calibrate, run, shrink",
    load: () => import("./model/cli.js").then((m) => m.runModelCli),
  },
  perf: {
    summary: "Read --perf crawl reports: emit budgets, gate on them, regress, drill down",
    load: () => import("./perf-cli.js").then((m) => m.runPerfCli),
  },
  scan: {
    summary: "Sweep an unknown site for bugs and slow spots: crawls with and without API faults",
    load: () => import("./scan/cli.js").then((m) => m.runScanCli),
  },
  drive: {
    summary: "Operate the browser towards a goal, with the checks running",
    load: () => import("./drive/cli.js").then((m) => m.runDriveCli),
  },
};

/** The SUBCOMMANDS section of `--help`: a line per entry of `SUBCOMMANDS`, in its order. */
export function formatSubcommandList(): string {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map((name) => name.length)) + 2;
  return Object.entries(SUBCOMMANDS)
    .map(([name, sub]) => `  ${name.padEnd(width)}${sub.summary}`)
    .join("\n");
}

/**
 * The installed package's version, read from its package.json at run time
 * (`../package.json` from both `src/` and `dist/`), so it is the version the
 * package was published as, not one copied into the source.
 */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof pkg.version !== "string") throw new Error("package.json has no version");
  return pkg.version;
}

/**
 * A subcommand refusing its arguments: a missing flag or operand, a value it
 * cannot use. `cli.ts` reports it as the main command reports its own, in one
 * `chaosbringer <sub>: …` line with exit 2: nothing ran. Thrown as a plain
 * Error it was `<sub> failed: …` and exit 1, the code of a run that found
 * something, which is how a CI step read a typo.
 *
 * `command` names a sub-subcommand (`perf gate`); see `inSubcommand`.
 */
export class UsageError extends Error {
  command?: string;
  constructor(message: string, command?: string) {
    super(message);
    this.name = "UsageError";
    if (command !== undefined) this.command = command;
  }
}

/** A `UsageError`, or `parseArgs` refusing an argv (an unknown flag, a missing value). */
export function isUsageError(err: unknown): boolean {
  if (err instanceof UsageError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

/**
 * Run a sub-subcommand so that a usage error out of it, `parseArgs`' too,
 * names it: `chaosbringer perf gate: …`, not `chaosbringer perf: …`.
 */
export async function inSubcommand<T>(command: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUsageError(err) && (err as UsageError).command === undefined) (err as UsageError).command = command;
    throw err;
  }
}

/**
 * The one line a refused invocation prints. `err` is what `parseArgs`, the
 * flag parsers or `validateOptions` threw; they used to escape as a Node
 * stack trace. `command` is who refused it: `chaosbringer`, or a subcommand
 * as `chaosbringer scan`.
 */
export function usageErrorMessage(err: unknown, command = "chaosbringer"): string {
  let message = err instanceof Error ? err.message : String(err);
  // parseArgs goes on to explain `--` for a positional that starts with a
  // "-", which a URL never does.
  if ((err as { code?: unknown } | null)?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const known = /^Unknown option '([^']+)'/.exec(message);
    if (known) message = `unknown option ${known[1]}`;
  }
  // validateOptions' messages carry the prefix already (`chaosbringer: `, or
  // a subcommand's `chaosbringer shard: `). parseArgs' advice for a value
  // that starts with a dash (`--timeout -5`) spans three lines.
  const text = message.replace(/^chaosbringer(?: [a-z-]+)*: /, "").replace(/\s*\n\s*/g, " ");
  return `${command}: ${text} (see ${command} --help)`;
}

/**
 * What `--compact` writes as each page starts. A terminal gets one line
 * redrawn in place; a pipe or a CI log gets a line per page, where the `\r`
 * ran them together as `Progress: 1/5 pagesProgress: 2/5 pages…`.
 */
export function progressText(visited: number, total: number, isTTY: boolean): string {
  const text = `Progress: ${visited}/${total} pages`;
  return isTTY ? `\r${text}` : `${text}\n`;
}
