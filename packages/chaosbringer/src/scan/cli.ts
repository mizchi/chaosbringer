/**
 * `chaosbringer scan --url <url>`: sweep an unknown site for bugs, fragile
 * error handling and slow spots, and write a triaged report. See `runScan`.
 */

import { parseArgs } from "node:util";
import { UsageError } from "../cli-usage.js";
import { errorMessage } from "../errors.js";
import { COMMON_IGNORE_PATTERNS, resolveIgnorePresets } from "../ignore-presets.js";
import { NETWORK_PROFILES, type NetworkProfile } from "../types.js";
import { SCAN_FAULT_KINDS, type ScanFaultKind, type ScanSeverity } from "./analyze.js";
import { formatScanSummary } from "./format.js";
import { DEFAULT_HANG_RELEASE_MS, DEFAULT_SCAN_DIR, runScan, type ScanOptions } from "./run.js";
import { HEADLESS_OPTIONS, resolveHeadless } from "../cli-headless.js";

const HELP = `
chaosbringer scan — sweep a site for bugs and slow spots

USAGE:
  chaosbringer scan --url <url> [options]

Runs a clean crawl with perf measurement, then the same crawl once per fault
(HTTP 500, network failure, no response) with every request to the site's own
API — the fetch / XHR endpoints the clean crawl saw — failing, and writes
a ranked list of findings: errors and broken pages, what breaks only when an
API fails, Web Vitals, main-thread blocking, layout and style work, heavy
pages, memory that climbs, unused JS. Each perf finding names the
perf-patterns catalog entries that produce the same signal.

OPTIONS:
  --url <url>             Site to scan (required)
  --max-pages <n>         Pages per crawl (default 20)
  --max-actions <n>       Random actions per page (default 5)
  --out <dir>             Output directory (default ${DEFAULT_SCAN_DIR})
  --no-chaos              Skip the fault-injected crawls
  --faults <list>         Which fault crawls to run (default 500,abort,hang)
  --seed <n>              Seed for every crawl (default random; printed)
  --axe                   Run axe-core accessibility checks (needs axe-core)
  --bind                  Serve each crawl's browser to other Playwright clients
                          (npx playwright cli attach <title>; the endpoint is printed)
  --bind-title <title>    Name to attach by (default chaosbringer)
  --aria-targets          Also act on controls only the accessibility snapshot sees
                          (a <div onclick> with a pointer cursor)
  --no-coverage           Skip JS / CSS coverage (the unused-JS finding)
  --hang-ms <ms>          How long the hang fault holds a request (default ${DEFAULT_HANG_RELEASE_MS})
  --exclude <regex>       Exclude URLs (repeatable), e.g. "/logout"
  --ignore-error <regex>  Ignore matching errors (repeatable)
  --ignore-analytics      Ignore common analytics script errors
  --ignore-preset <name>  Named ignore preset (repeatable; see chaosbringer --help)
  --sitemap <url|path>    Also start from the URLs in a sitemap.xml
  --storage-state <path>  Playwright storageState for a logged-in scan
  --network <profile>     Throttle every crawl: ${NETWORK_PROFILES.filter((p) => p !== "offline").join(", ")}
                          (a local server is too fast to cross the Web Vitals bounds without it)
  --device <name>         Emulate a Playwright device, e.g. "Pixel 7"
  --timeout <ms>          Page load timeout (default 30000)
  --no-headless           Show the browser
  --fail-on <severity>    Exit 1 when a finding at or above it exists: high | medium | low
  --quiet                 Only print the summary
  --help                  Show this help

OUTPUT (in --out):
  scan-report.md          The findings, readable
  scan-report.json        The findings, machine-readable
  clean-report.json       The clean crawl's full report
  chaos-<fault>-report.json  Each chaos crawl's full report; its reproCommand is the
                          chaosbringer scan … --faults <fault> command that reruns it
  perf/                   Per-page perf sidecars (for \`chaosbringer perf drilldown\`)

Only scan sites you own or are allowed to test: the crawl clicks, types and
submits forms. Exclude destructive URLs (logout, delete, checkout) with --exclude.
`;

const SEVERITIES: ScanSeverity[] = ["high", "medium", "low"];

export const SCAN_CLI_OPTIONS = {
  url: { type: "string" },
  "max-pages": { type: "string" },
  "max-actions": { type: "string" },
  out: { type: "string" },
  "no-chaos": { type: "boolean", default: false },
  faults: { type: "string" },
  seed: { type: "string" },
  axe: { type: "boolean", default: false },
  "aria-targets": { type: "boolean", default: false },
  bind: { type: "boolean", default: false },
  "bind-title": { type: "string" },
  "no-coverage": { type: "boolean", default: false },
  "hang-ms": { type: "string" },
  exclude: { type: "string", multiple: true },
  "ignore-error": { type: "string", multiple: true },
  "ignore-analytics": { type: "boolean", default: false },
  "ignore-preset": { type: "string", multiple: true },
  "storage-state": { type: "string" },
  sitemap: { type: "string" },
  network: { type: "string" },
  device: { type: "string" },
  timeout: { type: "string" },
  ...HEADLESS_OPTIONS,
  "fail-on": { type: "string" },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

export function parseScanArgs(argv: string[]) {
  return parseArgs({ args: argv, options: SCAN_CLI_OPTIONS });
}

export type ScanCliValues = ReturnType<typeof parseScanArgs>["values"];

export async function runScanCli(argv: string[]): Promise<void> {
  const { values } = parseScanArgs(argv);
  if (values.help) {
    console.log(HELP);
    return;
  }
  const options = scanOptionsFromCli(values);
  const failOn = values["fail-on"];

  const result = await runScan({ ...options, onProgress: values.quiet ? undefined : (line) => console.error(line) });

  console.log(formatScanSummary(result.analysis));
  console.log(`\nreport: ${result.files.markdown}\n        ${result.files.json}`);
  console.log(`seed: ${result.baseline.seed} (pass --seed to re-run the same actions)`);

  if (failOn) {
    const limit = SEVERITIES.indexOf(failOn as ScanSeverity);
    if (result.analysis.findings.some((f) => SEVERITIES.indexOf(f.severity) <= limit)) process.exitCode = 1;
  }
}

/**
 * The `runScan` options `values` ask for; throws on a value the CLI refuses.
 * Apart from `runScanCli` so a test can parse a chaos report's
 * `reproCommand` (`scanReproCommand`) back into the scan it came from.
 */
export function scanOptionsFromCli(values: ScanCliValues): ScanOptions {
  // Every check is a usage error: one `chaosbringer scan: …` line and exit 2
  // (cli.ts), not `scan failed: …` and exit 1, which --fail-on gates on.
  if (!values.url) throw new UsageError("--url is required");
  try {
    new URL(values.url);
  } catch {
    throw new UsageError(`--url must be an absolute URL (got ${JSON.stringify(values.url)})`);
  }
  const failOn = values["fail-on"];
  if (failOn !== undefined && !SEVERITIES.includes(failOn as ScanSeverity)) {
    throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(", ")} (got ${JSON.stringify(failOn)})`);
  }

  const network = values.network;
  if (network !== undefined && (network === "offline" || !NETWORK_PROFILES.includes(network as NetworkProfile))) {
    throw new UsageError(`--network must be one of ${NETWORK_PROFILES.filter((p) => p !== "offline").join(", ")} (got ${JSON.stringify(network)})`);
  }
  const faults = values.faults === undefined ? undefined : parseFaults(values.faults);

  const ignoreErrorPatterns = [...(values["ignore-error"] ?? [])];
  if (values["ignore-analytics"]) ignoreErrorPatterns.push(...COMMON_IGNORE_PATTERNS);
  for (const spec of values["ignore-preset"] ?? []) {
    try {
      ignoreErrorPatterns.push(...resolveIgnorePresets(spec));
    } catch (err) {
      throw new UsageError(`--ignore-preset: ${errorMessage(err)}`);
    }
  }
  const maxPages = intFlag("--max-pages", values["max-pages"], 1);
  const maxActionsPerPage = intFlag("--max-actions", values["max-actions"], 0);
  const seed = intFlag("--seed", values.seed, 0);
  const hangReleaseMs = intFlag("--hang-ms", values["hang-ms"], 1);
  const timeout = intFlag("--timeout", values.timeout, 1);

  return {
    url: values.url,
    maxPages,
    maxActionsPerPage,
    outDir: values.out,
    chaos: !values["no-chaos"],
    ...(faults ? { faults } : {}),
    seed,
    axe: values.axe,
    coverage: !values["no-coverage"],
    hangReleaseMs,
    crawler: {
      headless: resolveHeadless(values),
      ...(values["aria-targets"] ? { ariaTargets: true } : {}),
      ...(values.bind || values["bind-title"] ? { bind: values["bind-title"] ?? true } : {}),
      ...(values.exclude ? { excludePatterns: values.exclude } : {}),
      ...(ignoreErrorPatterns.length > 0 ? { ignoreErrorPatterns } : {}),
      ...(values["storage-state"] ? { storageState: values["storage-state"] } : {}),
      ...(values.sitemap ? { seedFromSitemap: values.sitemap } : {}),
      ...(network ? { network: network as NetworkProfile } : {}),
      ...(values.device ? { device: values.device } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    },
  };
}

/** `500,abort,hang` → fault kinds; `500` is the `status` crawl. */
export function parseFaults(raw: string): ScanFaultKind[] {
  const out: ScanFaultKind[] = [];
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const kind = part === "500" ? "status" : part;
    if (!SCAN_FAULT_KINDS.includes(kind as ScanFaultKind)) {
      throw new UsageError(`--faults: unknown fault ${JSON.stringify(part)} (known: 500, abort, hang)`);
    }
    if (!out.includes(kind as ScanFaultKind)) out.push(kind as ScanFaultKind);
  }
  if (out.length === 0) throw new UsageError("--faults needs at least one of 500, abort, hang (or pass --no-chaos)");
  return out;
}

function intFlag(flag: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  return n;
}
