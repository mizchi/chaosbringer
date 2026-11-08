/**
 * The main crawl's flags as a `Repro:` line carries them, for the tests that
 * check a flag survives the trip: argv → options → `reproCommand` → argv
 * (`repro-command.test.ts`), and that every one of them parses where a Repro
 * line is pasted (`flake`, `minimize`).
 */
import { execFileSync } from "node:child_process";
import { crawlerOptionsFromCli, parseCrawlArgs } from "./cli-crawl-options.js";
import { DEFAULT_OPTIONS } from "./defaults.js";
import type { CrawlerOptions } from "./types.js";

export const URL = "http://127.0.0.1:4455/";

/** argv → options the way the CLI does it: its own flag table, then its own builder. */
export function cliOptions(argv: string[]): CrawlerOptions {
  const { values, positionals } = parseCrawlArgs(argv);
  return crawlerOptionsFromCli(values, values.url ?? positionals[0]);
}

/** The options as the crawler holds them: defaults under what was set, and the seed it ran with. */
export function resolved(options: CrawlerOptions): Required<CrawlerOptions> {
  const set = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_OPTIONS, ...set, seed: options.seed ?? 1 } as Required<CrawlerOptions>;
}

/** A command split into words by `sh` itself, so the quoting is checked by a real shell. */
export function shellWords(command: string): string[] {
  return execFileSync("sh", ["-c", `printf '%s\\0' ${command}`], { encoding: "utf8" }).split("\0").slice(0, -1);
}

/** Invariants are closures; what tells two apart is their name, phase and scope. */
export function comparable(o: Required<CrawlerOptions>) {
  return { ...o, invariants: o.invariants.map((i) => ({ name: i.name, when: i.when, urlPattern: i.urlPattern })) };
}

/**
 * A sample for every main-CLI flag that changes what the run does or how it
 * exits. Each must come back unchanged from argv → options → reproCommand →
 * argv → options.
 */
export const ROUND_TRIPS: Record<string, string[]> = {
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
  "ignore-http": ["--ignore-http", "/favicon\\.ico$", "--ignore-http", "/api/me"],
  spa: ["--spa", "/app/.*"],
  "har-replay": ["--har-replay", "net.har"],
  "storage-state": ["--storage-state", "ss.json"],
  budget: ["--budget", "ttfb=200,lcp=2500"],
  axe: ["--axe"],
  "axe-tags": ["--axe", "--axe-tags", "wcag2a,wcag2aa"],
  "aria-targets": ["--aria-targets"],
  // Merged and de-duplicated, then written back in one canonical form.
  invariants: ["--invariants", "not-blank,xss-marker", "--invariants", "data-safety"],
  "data-safety": ["--data-safety"],
  // De-duplicated by origin, written back as one comma list.
  "offsite-redirect-allow": [
    "--data-safety",
    "--offsite-redirect-allow", "https://login.example.com,https://pay.example.net/",
    "--offsite-redirect-allow", "https://login.example.com",
  ],
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
  "fail-on-http": ["--fail-on-http", "4xx"],
  "fail-on-network": ["--fail-on-network"],
  "fail-on-dead-links": ["--fail-on-dead-links"],
  "fail-on-warnings": ["--fail-on-warnings"],
};
