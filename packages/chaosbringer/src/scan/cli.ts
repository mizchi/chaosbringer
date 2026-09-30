/**
 * `chaosbringer scan --url <url>`: sweep an unknown site for bugs, fragile
 * error handling and slow spots, and write a triaged report. See `runScan`.
 */

import { parseArgs } from "node:util";
import { COMMON_IGNORE_PATTERNS, resolveIgnorePresets } from "../ignore-presets.js";
import { NETWORK_PROFILES, type NetworkProfile } from "../types.js";
import { SCAN_FAULT_KINDS, type ScanFaultKind, type ScanSeverity } from "./analyze.js";
import { formatScanSummary } from "./format.js";
import { DEFAULT_HANG_RELEASE_MS, DEFAULT_SCAN_DIR, runScan } from "./run.js";

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
  chaos-<fault>-report.json  Each chaos crawl's full report
  perf/                   Per-page perf sidecars (for \`chaosbringer perf drilldown\`)

Only scan sites you own or are allowed to test: the crawl clicks, types and
submits forms. Exclude destructive URLs (logout, delete, checkout) with --exclude.
`;

const SEVERITIES: ScanSeverity[] = ["high", "medium", "low"];

export async function runScanCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      "max-pages": { type: "string" },
      "max-actions": { type: "string" },
      out: { type: "string" },
      "no-chaos": { type: "boolean", default: false },
      faults: { type: "string" },
      seed: { type: "string" },
      axe: { type: "boolean", default: false },
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
      "no-headless": { type: "boolean", default: false },
      "fail-on": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.url) throw new Error("--url is required (see chaosbringer scan --help)");
  try {
    new URL(values.url);
  } catch {
    throw new Error(`--url must be an absolute URL (got ${JSON.stringify(values.url)})`);
  }
  const failOn = values["fail-on"];
  if (failOn !== undefined && !SEVERITIES.includes(failOn as ScanSeverity)) {
    throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")} (got ${JSON.stringify(failOn)})`);
  }

  const network = values.network;
  if (network !== undefined && (network === "offline" || !NETWORK_PROFILES.includes(network as NetworkProfile))) {
    throw new Error(`--network must be one of ${NETWORK_PROFILES.filter((p) => p !== "offline").join(", ")} (got ${JSON.stringify(network)})`);
  }
  const faults = values.faults === undefined ? undefined : parseFaults(values.faults);

  const ignoreErrorPatterns = [...(values["ignore-error"] ?? [])];
  if (values["ignore-analytics"]) ignoreErrorPatterns.push(...COMMON_IGNORE_PATTERNS);
  for (const spec of values["ignore-preset"] ?? []) ignoreErrorPatterns.push(...resolveIgnorePresets(spec));

  const result = await runScan({
    url: values.url,
    maxPages: intFlag("--max-pages", values["max-pages"], 1),
    maxActionsPerPage: intFlag("--max-actions", values["max-actions"], 0),
    outDir: values.out,
    chaos: !values["no-chaos"],
    ...(faults ? { faults } : {}),
    seed: intFlag("--seed", values.seed, 0),
    axe: values.axe,
    coverage: !values["no-coverage"],
    hangReleaseMs: intFlag("--hang-ms", values["hang-ms"], 1),
    crawler: {
      headless: !values["no-headless"],
      ...(values.exclude ? { excludePatterns: values.exclude } : {}),
      ...(ignoreErrorPatterns.length > 0 ? { ignoreErrorPatterns } : {}),
      ...(values["storage-state"] ? { storageState: values["storage-state"] } : {}),
      ...(values.sitemap ? { seedFromSitemap: values.sitemap } : {}),
      ...(network ? { network: network as NetworkProfile } : {}),
      ...(values.device ? { device: values.device } : {}),
      ...(values.timeout !== undefined ? { timeout: intFlag("--timeout", values.timeout, 1) } : {}),
    },
    onProgress: values.quiet ? undefined : (line) => console.error(line),
  });

  console.log(formatScanSummary(result.analysis));
  console.log(`\nreport: ${result.files.markdown}\n        ${result.files.json}`);
  console.log(`seed: ${result.baseline.seed} (pass --seed to re-run the same actions)`);

  if (failOn) {
    const limit = SEVERITIES.indexOf(failOn as ScanSeverity);
    if (result.analysis.findings.some((f) => SEVERITIES.indexOf(f.severity) <= limit)) process.exitCode = 1;
  }
}

/** `500,abort,hang` → fault kinds; `500` is the `status` crawl. */
export function parseFaults(raw: string): ScanFaultKind[] {
  const out: ScanFaultKind[] = [];
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const kind = part === "500" ? "status" : part;
    if (!SCAN_FAULT_KINDS.includes(kind as ScanFaultKind)) {
      throw new Error(`--faults: unknown fault ${JSON.stringify(part)} (known: 500, abort, hang)`);
    }
    if (!out.includes(kind as ScanFaultKind)) out.push(kind as ScanFaultKind);
  }
  if (out.length === 0) throw new Error("--faults needs at least one of 500, abort, hang (or pass --no-chaos)");
  return out;
}

function intFlag(flag: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min} (got ${JSON.stringify(raw)})`);
  return n;
}
