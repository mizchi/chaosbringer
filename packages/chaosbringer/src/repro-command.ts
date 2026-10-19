/**
 * The `chaosbringer …` line a failing run prints so the reader can reproduce it.
 *
 * A pure function of the resolved options and the seed: it was a private method
 * reading `this`, which made the one thing a reader most wants to check — that
 * the printed command really does reproduce the run — impossible to test
 * without booting a browser.
 *
 * Only options that differ from the default are emitted, so the line stays
 * short enough to paste. Every main-CLI flag either reaches the command — a
 * branch here, or the CLI's own `cliReproFlags` — or is left out on purpose;
 * `repro-command.test.ts` holds that list and fails on a flag that is in
 * neither.
 *
 * Fault rules and invariants set in code have no flag. The command ends in a
 * comment that counts and names them (`unreplayedNote`): a `chaos()` run
 * whose 500 broke a page used to print a command that reran it clean and
 * passed, and said nothing.
 */
import { DEFAULT_OPTIONS } from "./defaults.js";
import { iframeFaultName } from "./iframe-faults.js";
import { COMMON_IGNORE_PATTERNS, IGNORE_PRESETS } from "./ignore-presets.js";
import { lifecycleFaultName } from "./lifecycle-faults.js";
import { runtimeFaultName } from "./runtime-faults.js";
import { settleReproArg } from "./settle.js";
import { PERF_BUDGET_KEYS } from "./types.js";
import type { CrawlerOptions, ReproFlag } from "./types.js";

/**
 * Shell-quote a value for inclusion in a reproducible CLI invocation.
 *
 * `?` and `&` used to pass unquoted: `--url http://x/?a=1&b=2` ran
 * `chaosbringer --url http://x/?a=1` in the background, and zsh refuses a `?`
 * that matches no file. A leading `=` is zsh's `=command` expansion.
 */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-:/.=@%+,]+$/.test(s) && !s.startsWith("=")) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Flags as shell words. A value starting with `-` is joined to its flag
 * (`--exclude=-x`): `parseArgs` refuses `--exclude -x` as ambiguous.
 */
export function formatReproFlags(flags: readonly ReproFlag[]): string[] {
  return flags.flatMap(({ flag, value }) => {
    if (value === undefined) return [flag];
    return value.startsWith("-") ? [`${flag}=${shellQuote(value)}`] : [flag, shellQuote(value)];
  });
}

export function buildReproCommand(
options: Required<CrawlerOptions>,
seed: number,
): string {
  return withUnreplayedNote(["chaosbringer", ...formatReproFlags(reproFlags(options, seed))].join(" "), options);
}

/**
 * `command`, ending in a `# + …` comment when `options` set something it
 * cannot carry. `unflagged` names other options it cannot carry (`scan`'s).
 */
export function withUnreplayedNote(command: string, options: UnreplayedOptions, unflagged: readonly string[] = []): string {
  const note = unreplayedNote(options, unflagged);
  return note ? `${command} # + ${note}` : command;
}

type UnreplayedOptions = Pick<
  CrawlerOptions,
  "faultInjection" | "lifecycleFaults" | "runtimeFaults" | "iframeFaults" | "invariants" | "cliReproFlags"
>;

/** The invariant each CLI flag builds, by the name it gives it (`cli-crawl-options.ts`). */
const CLI_INVARIANTS: ReadonlyMap<string, string> = new Map([
  ["--axe", "a11y-axe"],
  ["--visual-baseline", "visual-regression"],
]);

/** How many names a note lists before `+N more`. */
const NOTE_NAMES = 5;

/**
 * What a run set that no flag of its repro command carries, counted and
 * named, e.g. `1 fault rule not expressible on the CLI: scan:api-500`;
 * `undefined` when there is nothing. The fault layers and the invariants
 * other than the ones `--axe` / `--visual-baseline` built, then `unflagged`,
 * the other options the caller found no flag for (`scanReproCommand`'s
 * `crawler.spaPatterns`). A rule is named as its stats name it, an unnamed
 * network rule by its pattern.
 *
 * It follows a `#` on the repro line and in `repro.sh`, so it stays a plain
 * comment: control characters (a newline would start a command) become
 * spaces, and a name a shell would expand is quoted, which also keeps it
 * inert in a shell that reads `#` as a word (zsh without
 * `interactivecomments`).
 */
export function unreplayedNote(options: UnreplayedOptions, unflagged: readonly string[] = []): string | undefined {
  const invariants = (options.invariants ?? []).map((i) => i.name);
  for (const { flag } of options.cliReproFlags ?? []) {
    const built = CLI_INVARIANTS.get(flag);
    const at = built === undefined ? -1 : invariants.indexOf(built);
    if (at >= 0) invariants.splice(at, 1);
  }
  const groups: Array<[string, string[]]> = [
    ["fault rule", (options.faultInjection ?? []).map((r) => r.name ?? String(r.urlPattern))],
    ["lifecycle fault", (options.lifecycleFaults ?? []).map(lifecycleFaultName)],
    ["runtime fault", (options.runtimeFaults ?? []).map(runtimeFaultName)],
    ["iframe fault", (options.iframeFaults ?? []).map(iframeFaultName)],
    ["invariant", invariants],
    ["option", [...unflagged]],
  ];
  const present = groups.filter(([, names]) => names.length > 0);
  if (present.length === 0) return undefined;
  const counts = present.map(([noun, names]) => `${names.length} ${noun}${names.length === 1 ? "" : "s"}`);
  const names = present.flatMap(([, n]) => n).map((n) => shellQuote(n.replace(/\p{Cc}+/gu, " ")));
  const listed = names.length > NOTE_NAMES ? [...names.slice(0, NOTE_NAMES), `+${names.length - NOTE_NAMES} more`] : names;
  return `${counts.join(", ")} not expressible on the CLI: ${listed.join(", ")}`;
}

/** The flags of `buildReproCommand`, unquoted; a bundle's `repro.sh` is built from them too. */
export function reproFlags(options: Required<CrawlerOptions>, seed: number): ReproFlag[] {
  const flags: ReproFlag[] = [];
  const push = (flag: string, value?: string) => flags.push(value === undefined ? { flag } : { flag, value });
  const pushPath = (flag: string, value: string) => flags.push({ flag, value, path: true });
  push("--url", options.baseUrl);
  push("--seed", String(seed));
  if (options.cdpEndpoint) push("--cdp", options.cdpEndpoint);
  if (options.cdpTargetId) push("--cdp-target", options.cdpTargetId);
  if (options.terminalBrowser) push("--terminal-browser");
  if (options.maxPages !== DEFAULT_OPTIONS.maxPages) {
    push("--max-pages", String(options.maxPages));
  }
  if (options.maxActionsPerPage !== DEFAULT_OPTIONS.maxActionsPerPage) {
    push("--max-actions", String(options.maxActionsPerPage));
  }
  // The navigation timeout decides which slow page is a `timeout` failure.
  if (options.timeout !== DEFAULT_OPTIONS.timeout) {
    push("--timeout", String(options.timeout));
  }
  for (const p of options.excludePatterns ?? []) {
    push("--exclude", p);
  }
  for (const p of options.spaPatterns ?? []) {
    push("--spa", p);
  }
  flags.push(...ignoreReproFlags(options.ignoreErrorPatterns ?? []));
  if (options.storageState) {
    pushPath("--storage-state", options.storageState);
  }
  // Replay serves the pages' responses from the file. Recording only writes
  // one, and a repro would overwrite it, so `--har-record` is left out.
  if (options.har?.mode === "replay") {
    pushPath("--har-replay", options.har.path);
  }
  if (options.performanceBudget) {
    const budget = options.performanceBudget;
    const entries = PERF_BUDGET_KEYS.filter((k) => typeof budget[k] === "number")
      .map((k) => `${k}=${budget[k]}`)
      .join(",");
    if (entries.length > 0) push("--budget", entries);
  }
  if (options.traceOut) {
    push("--trace-out", options.traceOut);
  }
  if (options.traceReplay) {
    pushPath("--trace-replay", options.traceReplay);
  }
  if (options.device) {
    push("--device", options.device);
  }
  if (options.network) {
    push("--network", options.network);
  }
  // Both change what a step can find or load: the snapshot adds targets the
  // CSS scrape misses, and a cold cache refetches every sub-resource.
  if (options.ariaTargets) push("--aria-targets");
  if (options.httpCache === false) push("--no-http-cache");
  if (options.seedFromSitemap) {
    if (/^https?:\/\//i.test(options.seedFromSitemap)) push("--seed-from-sitemap", options.seedFromSitemap);
    else pushPath("--seed-from-sitemap", options.seedFromSitemap);
  }
  if (options.shardCount !== undefined && options.shardCount > 1) {
    push("--shard", `${options.shardIndex ?? 0}/${options.shardCount}`);
  }
  // A settle mode changes what every step waits for, so what the repro sees.
  const settle = settleReproArg(options.settle);
  if (settle !== null) push("--settle", settle);
  flags.push(...perfFlags(options));
  flags.push(...(options.cliReproFlags ?? []));
  return flags;
}

/**
 * `ignoreErrorPatterns` as the flags that build it. A run of patterns equal to
 * `--ignore-analytics`'s list or to a preset becomes that flag, and any other
 * pattern an `--ignore-error`. Longer lists are tried first, so
 * `--ignore-analytics` (the `analytics` preset plus `net::ERR_FAILED`) is not
 * read back as the preset and one stray pattern. `scan` has the same three
 * flags, so its repro command uses this too.
 */
export function ignoreReproFlags(patterns: readonly string[]): ReproFlag[] {
  const named: Array<{ flag: ReproFlag; patterns: readonly string[] }> = [
    { flag: { flag: "--ignore-analytics" }, patterns: COMMON_IGNORE_PATTERNS },
    ...Object.entries(IGNORE_PRESETS).map(([name, list]) => ({
      flag: { flag: "--ignore-preset", value: name },
      patterns: list,
    })),
  ].sort((a, b) => b.patterns.length - a.patterns.length);
  const out: ReproFlag[] = [];
  for (let i = 0; i < patterns.length; ) {
    const hit = named.find((n) => n.patterns.length > 0 && n.patterns.every((p, j) => patterns[i + j] === p));
    if (hit) {
      out.push(hit.flag);
      i += hit.patterns.length;
    } else {
      out.push({ flag: "--ignore-error", value: patterns[i] });
      i++;
    }
  }
  return out;
}

/**
 * The `--perf*` flags for `perf` / `perfBudgets`, so a repro measures the
 * way the run did: a regression that only shows with GC forced, or a budget
 * that failed, reproduces only with the same flags.
 *
 * `perf.actions: false` has no flag and is left out. `cssSelectorStats` has
 * none either; it implies trace level, which `--perf-trace` does give.
 * Budgets set in code have no file to point at and are omitted like other
 * programmatic-only options; budgets from `--perf-budgets <file>` point back
 * at that file.
 */
export function perfReproFlags(
  options: Pick<CrawlerOptions, "perf" | "perfBudgets" | "perfBudgetsFile">,
): string[] {
  return formatReproFlags(perfFlags(options));
}

function perfFlags(options: Pick<CrawlerOptions, "perf" | "perfBudgets" | "perfBudgetsFile">): ReproFlag[] {
  const out: ReproFlag[] = [];
  // Rules without `perf` turned measurement on (see the crawler), so the
  // repro measures too even when it cannot carry the rules themselves.
  const perf =
    options.perf ?? (options.perfBudgets && options.perfBudgets.length > 0 ? true : undefined);
  if (perf !== undefined && perf !== false) {
    const p = perf === true ? {} : perf;
    const trace = p.level === "trace" || p.cssSelectorStats === true;
    const mem = p.memory?.forceGc === true;
    const cov = p.coverage === true;
    // Every other flag implies --perf; spell it out only when nothing else
    // would. --perf-budgets implies it only with at least one rule (the
    // crawler turns perf on for non-empty rules), so an empty budgets file
    // does not count.
    const budgetsImplyPerf =
      !!options.perfBudgetsFile && !!options.perfBudgets && options.perfBudgets.length > 0;
    if (!trace && !mem && !cov && p.outDir === undefined && !budgetsImplyPerf) {
      out.push({ flag: "--perf" });
    }
    if (trace) out.push({ flag: "--perf-trace" });
    if (mem) out.push({ flag: "--perf-mem" });
    if (cov) out.push({ flag: "--perf-cov" });
    // An output, so not a `path`: from repro.sh, a relative --perf-out
    // writes into the bundle rather than over the run's. An absolute one is
    // still the run's directory, where the repro's files land beside the
    // run's, named by another run id.
    if (p.outDir !== undefined) out.push({ flag: "--perf-out", value: p.outDir });
  }
  if (options.perfBudgetsFile) out.push({ flag: "--perf-budgets", value: options.perfBudgetsFile, path: true });
  return out;
}
