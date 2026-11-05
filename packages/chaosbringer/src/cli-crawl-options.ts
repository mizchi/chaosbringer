/**
 * The main CLI's flags, and how they become `CrawlerOptions`.
 *
 * Out of `cli.ts`, which parses `process.argv` and exits as soon as it is
 * imported, so a test can read the flag table: every flag either round-trips
 * through `reproCommand` or is left out of it on purpose, and a flag added
 * here without either fails `repro-command.test.ts`.
 */
import { existsSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { devices } from "playwright";
import { HEADLESS_OPTIONS, resolveHeadless } from "./cli-headless.js";
import { isUsageError, PASTED_COMMENT, SUBCOMMANDS, UsageError } from "./cli-usage.js";
import { errorMessage } from "./errors.js";
import { buildInvariantPresets, formatInvariantsFlag, parseInvariantsFlag } from "./cli-invariants.js";
import { COMMON_IGNORE_PATTERNS, IGNORE_PRESETS, resolveIgnorePresets } from "./ignore-presets.js";
import { readInputJson } from "./input-files.js";
import { HTTP_FAIL_LEVELS, type ExitCodeOptions, type HttpFailLevel } from "./reporter.js";
import { BASELINE_MISSING_MODES, type BaselineMissingMode } from "./run-warnings.js";
import { axe } from "./invariants.js";
import { perfOptionsFromCliFlags } from "./perf-options.js";
import { parseSettleArg, resolveSettle } from "./settle.js";
import { parseShardArg } from "./shard.js";
import { AXE_PEERS, type PeerNeed, VISUAL_REGRESSION_PEERS } from "./peers.js";
import { PERF_BUDGET_KEYS, type CrawlerOptions, type Invariant, type PerfBudgetRule, type ReproFlag } from "./types.js";
import { nearestName } from "./validate.js";
import { visualRegression } from "./visual.js";

export const CRAWL_CLI_OPTIONS = {
  url: { type: "string" },
  "max-pages": { type: "string" },
  "max-actions": { type: "string" },
  // Alias to match the underlying CrawlerOptions field name (used by the
  // chaos-pr-gate workflow and surfaced as a synonym in docs).
  "max-actions-per-page": { type: "string" },
  timeout: { type: "string" },
  settle: { type: "string" },
  ...HEADLESS_OPTIONS,
  cdp: { type: "string" },
  "cdp-target": { type: "string" },
  "terminal-browser": { type: "boolean", default: false },
  screenshots: { type: "boolean", default: false },
  "screenshot-dir": { type: "string" },
  output: { type: "string" },
  exclude: { type: "string", multiple: true },
  "ignore-error": { type: "string", multiple: true },
  "ignore-http": { type: "string", multiple: true },
  "ignore-analytics": { type: "boolean", default: false },
  "ignore-preset": { type: "string", multiple: true },
  spa: { type: "string", multiple: true },
  "log-file": { type: "string" },
  "log-level": { type: "string" },
  "log-console": { type: "boolean", default: false },
  seed: { type: "string" },
  "har-record": { type: "string" },
  "har-replay": { type: "string" },
  "storage-state": { type: "string" },
  budget: { type: "string", multiple: true },
  axe: { type: "boolean", default: false },
  invariants: { type: "string", multiple: true },
  "data-safety": { type: "boolean", default: false },
  "aria-targets": { type: "boolean", default: false },
  bind: { type: "boolean", default: false },
  "bind-title": { type: "string" },
  "axe-tags": { type: "string" },
  "visual-baseline": { type: "string" },
  "visual-threshold": { type: "string" },
  "visual-max-diff-pixels": { type: "string" },
  "visual-max-diff-ratio": { type: "string" },
  "visual-diff-dir": { type: "string" },
  "visual-update": { type: "boolean", default: false },
  "failure-artifacts": { type: "string" },
  "cluster-artifacts": { type: "boolean", default: false },
  "cluster-min-count": { type: "string" },
  "failure-max": { type: "string" },
  "trace-out": { type: "string" },
  "no-http-cache": { type: "boolean", default: false },
  "trace-replay": { type: "string" },
  device: { type: "string" },
  network: { type: "string" },
  "seed-from-sitemap": { type: "string" },
  baseline: { type: "string" },
  "baseline-strict": { type: "boolean", default: false },
  "baseline-missing": { type: "string" },
  "github-annotations": { type: "boolean", default: false },
  shard: { type: "string" },
  heatmap: { type: "boolean", default: false },
  "heatmap-top": { type: "string" },
  "heatmap-out": { type: "string" },
  junit: { type: "string" },
  perf: { type: "boolean", default: false },
  "perf-trace": { type: "boolean", default: false },
  "perf-mem": { type: "boolean", default: false },
  "perf-cov": { type: "boolean", default: false },
  "perf-out": { type: "string" },
  "perf-budgets": { type: "string" },
  "allow-settle-mismatch": { type: "boolean", default: false },
  compact: { type: "boolean", default: false },
  strict: { type: "boolean", default: false },
  "fail-on-http": { type: "string" },
  "fail-on-network": { type: "boolean", default: false },
  "fail-on-dead-links": { type: "boolean", default: false },
  "fail-on-warnings": { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "V", default: false },
} as const;

/** A flag of the main crawl's table, by its name without the `--`. */
export type CrawlFlag = keyof typeof CRAWL_CLI_OPTIONS;

/**
 * `parseArgs`, refusing an unknown flag as `unknown option --exlude: did
 * you mean --exclude?` when one of the table's flags is close
 * (`nearestName`, the options check's own ranking). Otherwise it throws
 * what `parseArgs` throws, which the CLI prints as `unknown option --x`.
 * The main crawl, `flake` (both sides of its `--`), `minimize` and `drive`
 * parse with it.
 */
export function parseArgsSuggesting<T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /^Unknown option '--([^'=]+)'/.exec(String((err as Error).message)) : null;
    const near = unknown ? nearestName(unknown[1]!, Object.keys(config.options ?? {})) : undefined;
    if (unknown && near !== undefined) throw new UsageError(`unknown option --${unknown[1]}: did you mean --${near}?`);
    throw err;
  }
}

/** Parse the main CLI's arguments (`process.argv` when `args` is omitted). */
export function parseCrawlArgs(args?: string[]) {
  return parseArgsSuggesting({ args, options: CRAWL_CLI_OPTIONS, allowPositionals: true });
}

export type CrawlCliValues = ReturnType<typeof parseCrawlArgs>["values"];

/**
 * `CRAWL_CLI_OPTIONS` cut down to `flags`, to spread into a subcommand's own
 * table: the flag then parses, defaults and builds options
 * (`crawlerOptionsFromCli`) exactly as it does on the main crawl.
 */
export function crawlCliOptionsFor<const F extends readonly CrawlFlag[]>(flags: F): Pick<typeof CRAWL_CLI_OPTIONS, F[number]> {
  return Object.fromEntries(flags.map((f) => [f, CRAWL_CLI_OPTIONS[f]])) as Pick<typeof CRAWL_CLI_OPTIONS, F[number]>;
}

/**
 * The crawl flags `minimize` applies to every replay of the trace: what
 * shapes how a page loads, settles and what counts as an error on it. A
 * trace (format v2) records the options they build (`TraceSetup`), and a
 * replay applies the recording's unless the flag is given. The single list
 * behind `minimize --help`, its parser, and the docs' list.
 */
export const REPLAY_CRAWL_FLAGS = [
  "timeout",
  "settle",
  "headless",
  "no-headless",
  "exclude",
  "ignore-error",
  "ignore-http",
  "ignore-analytics",
  "ignore-preset",
  "spa",
  "storage-state",
  "har-replay",
  "device",
  "network",
  "no-http-cache",
  "invariants",
  "data-safety",
  "axe",
  "axe-tags",
] as const satisfies readonly CrawlFlag[];

/**
 * The flags a crawl's `Repro:` line can carry that `minimize` refuses, each
 * with why: the trace decides the visits and the actions, and `--match`, not
 * the exit rules, decides whether a replay reproduced. Accepting them would
 * read as if they had been applied.
 */
export const REPLAY_REFUSED_FLAGS: Readonly<Partial<Record<CrawlFlag, string>>> = {
  seed: "the trace decides the actions, so there is no random choice for a seed to make",
  "max-actions": "the trace decides the actions; minimize removes them itself",
  "max-actions-per-page": "the trace decides the actions; minimize removes them itself",
  "aria-targets": "the trace names each action's selector, so no targets are found",
  "seed-from-sitemap": "the trace decides the pages visited",
  shard: "the trace decides the pages visited",
  "trace-replay": "minimize replays --trace",
  strict: "--match decides whether a replay reproduced, not the exit rules",
  "fail-on-http": "--match decides whether a replay reproduced, not the exit rules",
  "fail-on-network": "--match decides whether a replay reproduced, not the exit rules",
  "fail-on-dead-links": "--match decides whether a replay reproduced, not the exit rules",
  "fail-on-warnings": "--match decides whether a replay reproduced, not the exit rules",
  cdp: "every replay starts a browser of its own",
  "cdp-target": "every replay starts a browser of its own",
  "terminal-browser": "every replay starts a browser of its own",
  budget: "minimize does not measure its replays",
  perf: "minimize does not measure its replays",
  "perf-trace": "minimize does not measure its replays",
  "perf-mem": "minimize does not measure its replays",
  "perf-cov": "minimize does not measure its replays",
  "perf-out": "minimize does not measure its replays",
  "perf-budgets": "minimize does not measure its replays",
  "allow-settle-mismatch": "minimize does not measure its replays",
  "visual-baseline": "minimize does not compare its replays' screenshots",
  "visual-threshold": "minimize does not compare its replays' screenshots",
  "visual-max-diff-pixels": "minimize does not compare its replays' screenshots",
  "visual-max-diff-ratio": "minimize does not compare its replays' screenshots",
};

/**
 * The crawl flags `drive` takes, where they fit how it runs: one browser
 * driven a step at a time, settling adaptively after each (`--settle` takes
 * `adaptive` or a quiet window in ms there, not `networkidle`).
 */
export const DRIVE_CRAWL_FLAGS = [
  "timeout",
  "settle",
  "headless",
  "no-headless",
  "exclude",
  "ignore-error",
  "ignore-analytics",
  "ignore-preset",
  "storage-state",
  "har-replay",
  "device",
  "network",
  "bind",
  "bind-title",
] as const satisfies readonly CrawlFlag[];

/**
 * `flags` as `--a, --b, …` lines for a subcommand's `--help`, wrapped at
 * `width` and indented by `indent`: the list is the table above, not a copy.
 */
export function formatFlagList(flags: readonly string[], indent = "  ", width = 88): string {
  const lines: string[] = [];
  let line = "";
  for (const [i, flag] of flags.entries()) {
    const word = `--${flag}${i < flags.length - 1 ? "," : ""}`;
    if (line !== "" && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines.join("\n");
}

/**
 * Run a builder of the main crawl's options for a subcommand: what it
 * throws as a plain `Error` (an unknown `--ignore-preset`, a bad `--seed`,
 * `validateOptions`) is a refusal of the invocation there too, a
 * `UsageError` (exit 2), not `<sub> failed:` and exit 1.
 */
export function asUsageError<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (isUsageError(err)) throw err;
    throw new UsageError(errorMessage(err));
  }
}

/**
 * The URL a crawl's arguments name, by `--url` or as its one positional.
 * Throws with the message the CLI prints after `chaosbringer: `; `shard`
 * checks its workers' arguments with it too.
 */
export function crawlUrlFromArgs(values: CrawlCliValues, positionals: readonly string[]): string {
  // A positional that is not a URL used to be dropped on the floor, which made
  // every wrong invocation look like a working one: `chaosbringer crawl --url X`
  // ran the default crawl and ignored the word `crawl`, so documentation that
  // invented a subcommand never got caught by anyone running it. There is no
  // `crawl` subcommand — crawling is what this binary does with no subcommand at
  // all.
  const looksLikeUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const first = positionals.find((p) => !looksLikeUrl(p));
  if (first !== undefined) {
    const known = Object.keys(SUBCOMMANDS).sort().join(", ");
    throw new Error(
      first === "crawl"
        ? 'unexpected argument "crawl": there is no `crawl` subcommand — crawling is the default, ' +
            "so drop the word: `chaosbringer --url <url>`"
        : first === "#"
          ? PASTED_COMMENT
          : `unexpected argument "${first}"; known subcommands: ${known}`,
    );
  }
  if (positionals.length > 1) {
    throw new Error(`expected one URL, got ${positionals.length}: ${positionals.join(" ")}`);
  }
  const baseUrl = values.url || positionals[0];
  if (!baseUrl) throw new Error("--url is required");
  return baseUrl;
}

/**
 * A number flag's value, or a `UsageError` naming the flag: the CLI prints
 * `chaosbringer[ <sub>]: <message>` and exits 2. Every subcommand's numbers
 * go through it: `parseInt("5s")` is 5, `parseFloat("abc")` NaN, and either
 * ran the command with a value nobody typed, and so did `Number("")`, which
 * is 0. A caller that reads an empty value as unset checks for it first.
 * `positive` is `> 0`, for a threshold that 0 would turn off
 * (`--perf-ratio 0` compared nothing).
 */
export function parseNumberFlag(
  flag: string,
  raw: string | undefined,
  opts: { min?: number; max?: number; integer?: boolean; positive?: boolean }
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  // `Number("")` is 0: an unset variable in `--perf-samples "$N"` ran with 0.
  if (raw.trim() === "" || !Number.isFinite(n)) {
    throw new UsageError(`${flag} must be a finite number (got ${JSON.stringify(raw)})`);
  }
  if (opts.integer && !Number.isInteger(n)) {
    throw new UsageError(`${flag} must be an integer (got ${n})`);
  }
  if (opts.positive && !(n > 0)) {
    throw new UsageError(`${flag} must be > 0 (got ${n})`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new UsageError(`${flag} must be >= ${opts.min} (got ${n})`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new UsageError(`${flag} must be <= ${opts.max} (got ${n})`);
  }
  return n;
}

/**
 * A regex flag's patterns, refused with the flag's name: validateOptions
 * refused `--exclude "("` as `excludePatterns entry has invalid regex`,
 * which names the option, not what was typed.
 */
export function checkRegexFlag(flag: string, patterns: readonly string[] | undefined): void {
  for (const pattern of patterns ?? []) {
    try {
      new RegExp(pattern);
    } catch (err) {
      throw new UsageError(`${flag} ${JSON.stringify(pattern)} is not a valid regex (${errorMessage(err)})`);
    }
  }
}

/**
 * `--device`, refused with the flag's name: validateOptions refused an
 * unknown one as `"device" "Nope 9" is not a known Playwright device
 * descriptor`, which names the option, not what was typed.
 */
export function checkDeviceFlag(device: string | undefined): void {
  if (device && !devices[device]) {
    throw new UsageError(`--device ${JSON.stringify(device)} is not a known Playwright device descriptor`);
  }
}

/** What the main CLI reads off its flags besides the crawler's options. */
export interface CrawlCliExtras {
  /** `--heatmap-top`, 20 without it. */
  heatmapTop: number;
  clusterMinCount: number | undefined;
}

/**
 * The flags the main CLI applies itself, after the crawl, checked before it
 * starts: a bad `--heatmap-top` used to fail only once the whole crawl had
 * run, and a `--cluster-artifacts` without `--failure-artifacts` exited before
 * the report was saved. Throws with the message the CLI prints after
 * `chaosbringer: `. `shard` runs it on its workers' arguments too, as it does
 * `crawlerOptionsFromCli`: a value only the workers refused failed in each of
 * them, and the run ended in "no reports produced" and exit 1.
 */
export function crawlCliExtras(values: CrawlCliValues): CrawlCliExtras {
  const heatmapTop = parseNumberFlag("--heatmap-top", values["heatmap-top"], { min: 0, integer: true }) ?? 20;
  const clusterMinCount = parseNumberFlag("--cluster-min-count", values["cluster-min-count"], {
    min: 0,
    integer: true,
  });
  if (values["cluster-artifacts"] && !values["failure-artifacts"]) {
    throw new Error("--cluster-artifacts requires --failure-artifacts <dir>: it copies from the per-page bundles");
  }
  return { heatmapTop, clusterMinCount };
}

/**
 * `--perf-budgets`, read by the CLI rather than the crawler, so a bad file
 * fails before a browser starts and the error names the flag. The rules'
 * contents are validated by the crawler (validatePerfBudgets), the same as for
 * the programmatic option. Throws on a file it cannot read; `undefined`
 * without the flag.
 *
 * A file `perf emit-budgets` wrote records the settle mode it was measured
 * under. Enforcing it on a crawl settled another way fails (or passes) every
 * action budget on the settle, not the app, so it is refused like `perf gate`
 * does: `refusal` is the message (after `chaosbringer: `) and the exit code,
 * or, with `--allow-settle-mismatch`, `warning` is what to print instead.
 */
export async function readCrawlPerfBudgets(
  values: CrawlCliValues,
  settle: CrawlerOptions["settle"],
): Promise<{ rules: PerfBudgetRule[]; warning?: string; refusal?: { message: string; exitCode: number } } | undefined> {
  const file = values["perf-budgets"];
  if (file === undefined) return undefined;
  // Read as the other input files are: a missing one was a bare
  // `ENOENT: no such file or directory, open '…'`, without the flag.
  const json = readInputJson("--perf-budgets", file, "perf budgets");
  // Imported on demand: perf-cli is otherwise only loaded for `chaosbringer perf`.
  const { perfBudgetsForCrawl } = await import("./perf-cli.js");
  const read = perfBudgetsForCrawl(json, resolveSettle(settle), `--perf-budgets ${file}`);
  if (!read.settleMismatch) return { rules: read.rules };
  if (values["allow-settle-mismatch"]) {
    return { rules: read.rules, warning: `[perf-budgets] WARNING (--allow-settle-mismatch): ${read.settleMismatch}.` };
  }
  return {
    rules: read.rules,
    refusal: {
      message:
        `--perf-budgets ${file}: refusing to enforce: ${read.settleMismatch}. ` +
        `Crawl with the --settle the budgets were emitted under, re-run \`perf emit-budgets\`, ` +
        `or pass --allow-settle-mismatch to enforce anyway.`,
      exitCode: read.exitCode,
    },
  };
}

/**
 * The crawl `values` ask for. Throws on a value the CLI refuses, with the
 * message it prints after `chaosbringer: `. `--perf-budgets` is only named here
 * (`perfBudgetsFile`): `readCrawlPerfBudgets` reads the rules.
 */
export function crawlerOptionsFromCli(values: Partial<CrawlCliValues>, baseUrl: string): CrawlerOptions {
  // Build ignore patterns
  const ignoreErrorPatterns: string[] = [...(values["ignore-error"] || [])];
  if (values["ignore-analytics"]) {
    ignoreErrorPatterns.push(...COMMON_IGNORE_PATTERNS);
  }
  for (const presetSpec of values["ignore-preset"] ?? []) {
    try {
      ignoreErrorPatterns.push(...resolveIgnorePresets(presetSpec));
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : err}\n` +
          `Tip: --ignore-preset accepts comma-separated names. Known: ${Object.keys(IGNORE_PRESETS).join(", ")}`,
      );
    }
  }

  // Validate log level
  const validLogLevels = ["debug", "info", "warn", "error"] as const;
  const logLevel = values["log-level"] as (typeof validLogLevels)[number] | undefined;
  if (logLevel && !validLogLevels.includes(logLevel)) {
    throw new Error(`Invalid log level "${logLevel}". Valid levels: ${validLogLevels.join(", ")}`);
  }

  let seed: number | undefined;
  if (values.seed !== undefined) {
    const parsed = Number(values.seed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--seed must be a non-negative integer, got "${values.seed}"`);
    }
    seed = parsed;
  }

  let har: CrawlerOptions["har"];
  if (values["har-record"] && values["har-replay"]) {
    throw new Error("--har-record and --har-replay are mutually exclusive");
  }
  if (values["har-record"]) har = { path: values["har-record"], mode: "record" };
  if (values["har-replay"]) har = { path: values["har-replay"], mode: "replay" };

  // Each value is checked as `--budget <metric>`: an unchecked `Number` made
  // `lcp=abc` NaN, which validateOptions refused as `"performanceBudget.lcp"
  // must be a positive number of ms (got null)`, without the flag.
  let performanceBudget: CrawlerOptions["performanceBudget"];
  if (values.budget && values.budget.length > 0) {
    performanceBudget = {};
    for (const raw of values.budget) {
      for (const entry of raw.split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        const value = trimmed.slice(eq + 1).trim();
        if (eq <= 0 || value === "") {
          throw new Error(`--budget expects key=ms pairs (got "${trimmed}")`);
        }
        const key = trimmed.slice(0, eq).trim();
        if (!(PERF_BUDGET_KEYS as readonly string[]).includes(key)) {
          throw new Error(`--budget ${key}: unknown metric (known: ${PERF_BUDGET_KEYS.join(", ")})`);
        }
        (performanceBudget as Record<string, number | undefined>)[key] = parseNumberFlag(`--budget ${key}`, value, {
          positive: true,
        });
      }
    }
  }

  let settle: CrawlerOptions["settle"];
  if (values.settle !== undefined) {
    try {
      settle = parseSettleArg(values.settle);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  let shardIndex: number | undefined;
  let shardCount: number | undefined;
  if (values.shard) {
    const parsed = parseShardArg(values.shard);
    shardIndex = parsed.shardIndex;
    shardCount = parsed.shardCount;
  }

  checkRegexFlag("--exclude", values.exclude);
  checkRegexFlag("--ignore-error", values["ignore-error"]);
  checkRegexFlag("--ignore-http", values["ignore-http"]);
  checkRegexFlag("--spa", values.spa);
  checkDeviceFlag(values.device);

  const cliReproFlags = cliOnlyReproFlags(values);
  return {
    ...(values["aria-targets"] ? { ariaTargets: true } : {}),
    ...(values.bind || values["bind-title"] ? { bind: values["bind-title"] ?? true } : {}),
    baseUrl,
    // parseNumberFlag, not parseInt: `--max-pages abc` was NaN, which
    // validateOptions refused as `"maxPages" … (got null)` without naming
    // the flag, and `--max-pages 3x` ran 3 pages.
    maxPages: values["max-pages"]
      ? parseNumberFlag("--max-pages", values["max-pages"], { min: 1, integer: true })
      : undefined,
    maxActionsPerPage: (() => {
      const flag = values["max-actions"] !== undefined ? "--max-actions" : "--max-actions-per-page";
      const raw = values["max-actions"] ?? values["max-actions-per-page"];
      return raw ? parseNumberFlag(flag, raw, { min: 0, integer: true }) : undefined;
    })(),
    timeout: values.timeout ? parseNumberFlag("--timeout", values.timeout, { min: 1, integer: true }) : undefined,
    settle,
    headless: resolveHeadless(values),
    cdpEndpoint: values.cdp,
    cdpTargetId: values["cdp-target"],
    terminalBrowser: values["terminal-browser"],
    screenshots: values.screenshots,
    screenshotDir: values["screenshot-dir"],
    excludePatterns: values.exclude,
    ignoreErrorPatterns: ignoreErrorPatterns.length > 0 ? ignoreErrorPatterns : undefined,
    ignoreHttpPatterns: values["ignore-http"],
    spaPatterns: values.spa,
    logFile: values["log-file"],
    logLevel: logLevel,
    logToConsole: values["log-console"],
    seed,
    har,
    storageState: values["storage-state"],
    performanceBudget,
    traceOut: values["trace-out"],
    httpCache: values["no-http-cache"] ? false : undefined,
    traceReplay: values["trace-replay"],
    device: values.device,
    network: values.network as CrawlerOptions["network"],
    seedFromSitemap: values["seed-from-sitemap"],
    shardIndex,
    shardCount,
    failureArtifacts: values["failure-artifacts"]
      ? {
          dir: values["failure-artifacts"],
          maxArtifacts: parseNumberFlag("--failure-max", values["failure-max"], {
            min: 0,
            integer: true,
          }),
        }
      : undefined,
    invariants: buildInvariants(values),
    perf: perfOptionsFromCliFlags(values),
    perfBudgetsFile: values["perf-budgets"],
    ...(cliReproFlags.length > 0 ? { cliReproFlags } : {}),
  };
}

/**
 * The exit rules the flags ask for, which the CLI applies to the report
 * (`getExitCode`) and the GitHub annotations: `--strict`, `--baseline-strict`,
 * `--fail-on-http`, `--fail-on-network`, `--fail-on-dead-links`,
 * `--fail-on-warnings`. Throws a
 * `UsageError` on a `--fail-on-http` that is not `4xx` or `5xx`, before a
 * browser starts; `shard` checks its workers' arguments with it too.
 */
export function exitOptionsFromCli(values: Partial<CrawlCliValues>): ExitCodeOptions {
  const http = values["fail-on-http"];
  if (http !== undefined && !(HTTP_FAIL_LEVELS as readonly string[]).includes(http)) {
    throw new UsageError(
      `--fail-on-http must be one of ${HTTP_FAIL_LEVELS.join(", ")} (got ${JSON.stringify(http)}): ` +
        "5xx fails on a response of 500 and up, 4xx on one of 400 and up",
    );
  }
  return {
    strict: values.strict,
    baselineStrict: values["baseline-strict"],
    ...(http !== undefined ? { http: http as HttpFailLevel } : {}),
    ...(values["fail-on-network"] ? { network: true } : {}),
    ...(values["fail-on-dead-links"] ? { deadLinks: true } : {}),
    ...(values["fail-on-warnings"] ? { warnings: true } : {}),
  };
}

/**
 * `--baseline-missing`: `warn` (the default: the bootstrap run, whose report
 * becomes the first baseline) or `fail`. Throws a `UsageError` on another
 * value, and under `fail` on a `--baseline` file that is not there (or no
 * `--baseline` at all: an unset variable in `--baseline "$PREV"`), before a
 * browser starts: a CI cache miss or a typo'd path turned a
 * `--baseline-strict` gate green. `shard` checks its workers' arguments with
 * it too.
 */
export function baselineMissingFromCli(values: Pick<CrawlCliValues, "baseline" | "baseline-missing">): BaselineMissingMode {
  const raw = values["baseline-missing"];
  if (raw !== undefined && !(BASELINE_MISSING_MODES as readonly string[]).includes(raw)) {
    throw new UsageError(
      `--baseline-missing must be one of ${BASELINE_MISSING_MODES.join(", ")} (got ${JSON.stringify(raw)}): ` +
        "warn runs without a diff and warns, fail refuses the run",
    );
  }
  const mode = (raw ?? "warn") as BaselineMissingMode;
  if (mode === "fail") {
    const path = values.baseline;
    if (!path) throw new UsageError("--baseline-missing fail needs a --baseline <path> to require");
    if (!existsSync(path)) {
      throw new UsageError(
        `--baseline ${path}: not found, and --baseline-missing fail refuses a run without it ` +
          "(drop the flag, or pass --baseline-missing warn, for the first run, whose report becomes the baseline)",
      );
    }
  }
  return mode;
}

/**
 * The optional peer dependencies the flags need, by flag, for `assertPeers`
 * before the browser starts: the crawl's own check of the invariants they
 * become names the invariant, not the flag.
 */
export function crawlCliPeerNeeds(values: Partial<Pick<CrawlCliValues, "axe" | "invariants" | "visual-baseline">>): PeerNeed[] {
  const needs: PeerNeed[] = [];
  if (values.axe) needs.push({ by: "--axe", peers: AXE_PEERS });
  else if (parseInvariantsFlag(values.invariants).axe) needs.push({ by: "--invariants axe", peers: AXE_PEERS });
  if (values["visual-baseline"]) needs.push({ by: "--visual-baseline", peers: VISUAL_REGRESSION_PEERS });
  return needs;
}

/**
 * The invariants the flags build: `--axe` (or `--invariants axe`), then the
 * `--invariants` / `--data-safety` presets (`cli-invariants.ts`), then
 * `--visual-baseline`. Throws a `UsageError` on a name `--invariants` does
 * not know.
 */
function buildInvariants(values: Partial<CrawlCliValues>): Invariant[] | undefined {
  const list: Invariant[] = [];
  const flag = parseInvariantsFlag(values.invariants, values["data-safety"]);
  if (values.axe || flag.axe) {
    list.push(
      axe({
        tags: values["axe-tags"]
          ? values["axe-tags"]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      })
    );
  }
  list.push(...buildInvariantPresets(flag.presets));
  if (values["visual-baseline"]) {
    list.push(
      visualRegression({
        baselineDir: values["visual-baseline"],
        threshold: parseNumberFlag("--visual-threshold", values["visual-threshold"], {
          min: 0,
          max: 1,
        }),
        maxDiffPixels: parseNumberFlag(
          "--visual-max-diff-pixels",
          values["visual-max-diff-pixels"],
          { min: 0, integer: true }
        ),
        maxDiffRatio: parseNumberFlag(
          "--visual-max-diff-ratio",
          values["visual-max-diff-ratio"],
          { min: 0, max: 1 }
        ),
        diffDir: values["visual-diff-dir"],
        updateBaseline: values["visual-update"],
      })
    );
  }
  return list.length > 0 ? list : undefined;
}

/**
 * The flags that change the run or its exit code in a form
 * `buildReproCommand` cannot read back from the options: the CLI applies
 * `--strict` and the `--fail-on-*` rules itself, `--axe` / `--invariants` / `--data-safety` /
 * `--visual-*` become invariant closures, and `--allow-settle-mismatch` lifts
 * a refusal the CLI makes. `--invariants axe` is carried as `--axe`, and
 * `--data-safety` and every `--invariants` as one canonical `--invariants`
 * value (`formatInvariantsFlag`). Left out:
 * `--visual-diff-dir` only writes files, and a repro run with
 * `--visual-update` would rewrite the baselines and hide the diff it is
 * meant to reproduce.
 */
function cliOnlyReproFlags(values: Partial<CrawlCliValues>): ReproFlag[] {
  const out: ReproFlag[] = [];
  const invariants = parseInvariantsFlag(values.invariants, values["data-safety"]);
  if (values.axe || invariants.axe) {
    out.push({ flag: "--axe" });
    if (values["axe-tags"] !== undefined) out.push({ flag: "--axe-tags", value: values["axe-tags"] });
  }
  if (invariants.presets.length > 0) out.push({ flag: "--invariants", value: formatInvariantsFlag(invariants.presets) });
  if (values["visual-baseline"]) {
    out.push({ flag: "--visual-baseline", value: values["visual-baseline"], path: true });
    for (const name of ["visual-threshold", "visual-max-diff-pixels", "visual-max-diff-ratio"] as const) {
      const value = values[name];
      if (value !== undefined) out.push({ flag: `--${name}`, value });
    }
  }
  // Without it the repro refuses the run's --perf-budgets file (exit 2).
  if (values["allow-settle-mismatch"]) out.push({ flag: "--allow-settle-mismatch" });
  if (values.strict) out.push({ flag: "--strict" });
  if (values["fail-on-http"] !== undefined) out.push({ flag: "--fail-on-http", value: values["fail-on-http"] });
  if (values["fail-on-network"]) out.push({ flag: "--fail-on-network" });
  if (values["fail-on-dead-links"]) out.push({ flag: "--fail-on-dead-links" });
  if (values["fail-on-warnings"]) out.push({ flag: "--fail-on-warnings" });
  return out;
}
