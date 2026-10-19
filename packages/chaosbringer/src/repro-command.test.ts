import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CRAWL_CLI_OPTIONS, crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import { DEFAULT_OPTIONS } from "./defaults.js";
import { compileFaultRules, faultStatsOf } from "./fault-router.js";
import { faults } from "./faults.js";
import { buildReproCommand, formatReproFlags, shellQuote, unreplayedNote } from "./repro-command.js";
import type { CrawlerOptions } from "./types.js";

const URL = "http://127.0.0.1:4455/";

/** argv → options the way the CLI does it: its own flag table, then its own builder. */
function cliOptions(argv: string[]): CrawlerOptions {
  const { values, positionals } = parseCrawlArgs(argv);
  return crawlerOptionsFromCli(values, values.url ?? positionals[0]);
}

/** The options as the crawler holds them: defaults under what was set, and the seed it ran with. */
function resolved(options: CrawlerOptions): Required<CrawlerOptions> {
  const set = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_OPTIONS, ...set, seed: options.seed ?? 1 } as Required<CrawlerOptions>;
}

/** A command split into words by `sh` itself, so the quoting is checked by a real shell. */
function shellWords(command: string): string[] {
  return execFileSync("sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).split("\0").slice(0, -1);
}

/** Invariants are closures; what tells two apart is their name, phase and scope. */
function comparable(o: Required<CrawlerOptions>) {
  return { ...o, invariants: o.invariants.map((i) => ({ name: i.name, when: i.when, urlPattern: i.urlPattern })) };
}

/**
 * A sample for every main-CLI flag that changes what the run does or how it
 * exits. Each must come back unchanged from argv → options → reproCommand →
 * argv → options.
 */
const ROUND_TRIPS: Record<string, string[]> = {
  // `&` and `?` used to go unquoted, and `&` ended the command.
  url: ["--url", "http://127.0.0.1:4455/search?q=a&page=2"],
  seed: ["--seed", "7"],
  "max-pages": ["--max-pages", "3"],
  "max-actions": ["--max-actions", "2"],
  "max-actions-per-page": ["--max-actions-per-page", "2"],
  timeout: ["--timeout", "5000"],
  settle: ["--settle", "adaptive"],
  cdp: ["--cdp", "9222"],
  "cdp-target": ["--cdp", "9222", "--cdp-target", "ABC123"],
  "terminal-browser": ["--terminal-browser"],
  // parseArgs refuses `--exclude -x`; the repro has to write `--exclude=-x`.
  exclude: ["--exclude", "/logout", "--exclude=-x"],
  "ignore-error": ["--ignore-error", "third-party", "--ignore-error", "it's \\.js$"],
  "ignore-analytics": ["--ignore-analytics", "--ignore-preset", "analytics"],
  "ignore-preset": ["--ignore-preset", "maps,pdf-orb", "--ignore-preset", "iframe-sandbox"],
  spa: ["--spa", "/app/.*"],
  "har-replay": ["--har-replay", "net.har"],
  "storage-state": ["--storage-state", "ss.json"],
  budget: ["--budget", "ttfb=200,lcp=2500"],
  axe: ["--axe"],
  "axe-tags": ["--axe", "--axe-tags", "wcag2a,wcag2aa"],
  "aria-targets": ["--aria-targets"],
  "visual-baseline": ["--visual-baseline", "baselines"],
  "visual-threshold": ["--visual-baseline", "b", "--visual-threshold", "0.2"],
  "visual-max-diff-pixels": ["--visual-baseline", "b", "--visual-max-diff-pixels", "10"],
  "visual-max-diff-ratio": ["--visual-baseline", "b", "--visual-max-diff-ratio", "0.01"],
  "trace-out": ["--trace-out", "t.jsonl"],
  "no-http-cache": ["--no-http-cache"],
  "trace-replay": ["--trace-replay", "t.jsonl"],
  device: ["--device", "Pixel 7"],
  network: ["--network", "slow-3g"],
  "seed-from-sitemap": ["--seed-from-sitemap", "sitemap.xml"],
  shard: ["--shard", "1/3"],
  perf: ["--perf"],
  "perf-trace": ["--perf-trace"],
  "perf-mem": ["--perf-mem"],
  "perf-cov": ["--perf-cov"],
  "perf-out": ["--perf-out", "perf dir"],
  "perf-budgets": ["--perf-budgets", "budgets.json"],
  // Without it the repro refuses a budgets file emitted under another --settle.
  "allow-settle-mismatch": ["--perf-budgets", "b.json", "--allow-settle-mismatch"],
  strict: ["--strict"],
};

/**
 * Flags a repro leaves out on purpose, with why. Each only changes what the
 * run writes or shows, not what it does or how it exits.
 */
const LEFT_OUT: Record<string, string> = {
  headless: "the reader decides whether to watch the window; the crawl is the same",
  "no-headless": "the reader decides whether to watch the window; the crawl is the same",
  screenshots: "writes files",
  "screenshot-dir": "writes files",
  output: "where the report is written",
  "log-file": "logging",
  "log-level": "logging",
  "log-console": "logging",
  "har-record": "writes a HAR; a repro would overwrite the run's",
  bind: "lets other clients watch the browser",
  "bind-title": "lets other clients watch the browser",
  "visual-diff-dir": "writes diff images",
  "visual-update": "rewrites the baselines the repro has to compare against",
  "failure-artifacts": "writes bundles",
  "failure-max": "writes bundles",
  "cluster-artifacts": "writes bundles",
  "cluster-min-count": "writes bundles",
  // A diff against another run's report, usually a CI download the repro
  // machine does not have; the repro reproduces the run's own failures.
  baseline: "compares against another report",
  "baseline-strict": "compares against another report",
  "github-annotations": "output format",
  heatmap: "output format",
  "heatmap-top": "output format",
  "heatmap-out": "writes a file",
  junit: "writes a file",
  compact: "output format",
  quiet: "output format",
  help: "not a run",
  version: "not a run",
};

describe("reproCommand covers the main CLI's flags", () => {
  it("names every flag of the CLI's table exactly once, and nothing else", () => {
    const flags = Object.keys(CRAWL_CLI_OPTIONS).sort();
    const listed = [...Object.keys(ROUND_TRIPS), ...Object.keys(LEFT_OUT)].sort();
    expect(listed).toEqual(flags);
  });

  const base = comparable(resolved(cliOptions(["--url", URL])));

  it.each(Object.entries(ROUND_TRIPS))("--%s round-trips", (flag, argv) => {
    expect(argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`))).toBe(true);
    const before = resolved(cliOptions(["--url", URL, ...argv]));
    // A sample that changed nothing would pass without testing anything.
    expect(comparable(before)).not.toEqual(base);

    const command = buildReproCommand(before, before.seed);
    // The --axe / --visual-* invariants are the flags': nothing is left to note.
    expect(unreplayedNote(before)).toBeUndefined();
    const words = shellWords(command);
    expect(words[0]).toBe("chaosbringer");
    // parseArgs is strict: an unknown or malformed flag throws here.
    const after = resolved(cliOptions(words.slice(1)));
    expect(comparable(after)).toEqual(comparable(before));
    expect(buildReproCommand(after, after.seed)).toBe(command);
  });
});

describe("reproCommand of a run with faults and invariants set in code", () => {
  const plain = ["chaosbringer", "--url", URL, "--seed", "1"];

  it("ends in a comment that counts and names them, which a shell skips", () => {
    // What scan's 500 crawl set: its repro reran clean and passed, and said nothing.
    const o = resolved({ baseUrl: URL, faultInjection: [faults.status(500, { urlPattern: "/api/", name: "scan:api-500" })] });
    const command = buildReproCommand(o, 1);
    expect(command).toBe(`chaosbringer --url ${URL} --seed 1 # + 1 fault rule not expressible on the CLI: scan:api-500`);
    expect(shellWords(command)).toEqual(plain);
  });

  it("covers every fault layer and the invariants no flag built", () => {
    const o = resolved({
      ...cliOptions(["--url", URL, "--axe"]),
      faultInjection: [faults.abort({ urlPattern: /\/api\/(cart|items)/ })],
      lifecycleFaults: [faults.cpu(4)],
      runtimeFaults: [faults.rejectBody({ urlPattern: "/api/" })],
      iframeFaults: [faults.iframeNeverLoad({ selector: "iframe" })],
      invariants: [...(cliOptions(["--url", URL, "--axe"]).invariants ?? []), { name: "cart-total", check: () => true }],
    });
    const command = buildReproCommand(o, 1);
    expect(command).toBe(
      `chaosbringer --url ${URL} --seed 1 --axe # + 1 fault rule, 1 lifecycle fault, 1 runtime fault, 1 iframe fault, 1 invariant ` +
        `not expressible on the CLI: '/\\/api\\/(cart|items)/', cpu-throttle:4x, reject-body:json, iframe-never-load, cart-total`,
    );
    expect(shellWords(command)).toEqual([...plain, "--axe"]);
  });

  // The note named it "/api/" and the stats `/\/api\//`, so the two did not
  // read as the same rule.
  it("names an unnamed rule with a string pattern as its stats do", () => {
    const rules = [faults.status(500, { urlPattern: "/api/" }), faults.abort({ urlPattern: /\/img\//g })];
    const stats = faultStatsOf(compileFaultRules(rules)).map((s) => s.rule);
    expect(stats).toEqual(["/\\/api\\//", "/\\/img\\//"]);
    expect(unreplayedNote({ faultInjection: rules })).toBe(
      `2 fault rules not expressible on the CLI: ${stats.map(shellQuote).join(", ")}`,
    );
  });

  it("keeps a name a shell would act on inside the comment", () => {
    const o = resolved({
      baseUrl: URL,
      invariants: [1, 2, 3, 4, 5].map((i) => ({ name: `inv-${i}`, check: () => true })),
      faultInjection: [faults.status(500, { urlPattern: "/x", name: "x\necho INJECTED; $(echo also)" })],
    });
    const command = buildReproCommand(o, 1);
    expect(command).not.toContain("\n");
    // The rule's name first, then five names and the count of the rest.
    expect(command).toMatch(/: 'x echo INJECTED; \$\(echo also\)', inv-1, inv-2, inv-3, inv-4, \+1 more$/);
    expect(shellWords(command)).toEqual(plain);
  });

  it("says nothing for a run with none", () => {
    expect(buildReproCommand(resolved({ baseUrl: URL }), 1)).toBe(`chaosbringer --url ${URL} --seed 1`);
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone", () => {
    for (const s of ["http://127.0.0.1:4455/a/b.html", "ttfb=200,lcp=2500", "1/3", "a@b%c+d"]) {
      expect(shellQuote(s)).toBe(s);
    }
  });

  it("quotes what a shell would expand or split", () => {
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("Pixel 7")).toBe("'Pixel 7'");
    expect(shellQuote("/a?b")).toBe("'/a?b'");
    expect(shellQuote("/a&b")).toBe("'/a&b'");
    expect(shellQuote("=x")).toBe("'=x'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("joins a value starting with - to its flag", () => {
    expect(formatReproFlags([{ flag: "--exclude", value: "-x y" }, { flag: "--strict" }])).toEqual([
      "--exclude='-x y'",
      "--strict",
    ]);
  });
});
