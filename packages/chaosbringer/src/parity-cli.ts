/**
 * `chaosbringer parity --left URL --right URL --paths file [--output file]`.
 * See `parity.ts` for design notes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { summariseBodyDiff } from "./body-diff.js";
import { type PerfPercentile, runParity } from "./parity.js";

const PERF_PERCENTILES: readonly PerfPercentile[] = ["min", "median", "p95", "p99"];

const HELP = `Usage: chaosbringer parity --left <url> --right <url> --paths <file> [options]

Probe the same paths against two base URLs and report routing-bug
mismatches: status code differences, redirect target differences, and
one-side-only fetch failures. Designed for the dual-runtime regression
workflow where random crawls cannot isolate route divergence from
third-party noise.

Required:
  --left <url>       First base URL
  --right <url>      Second base URL
  --paths <file>     File with one path per line (blank lines and lines
                     starting with '#' are skipped)

Options:
  --output <file>    Write the full report (JSON) to this path
  --follow-redirects Follow redirects on both sides and compare the
                     final status. Default is manual (compare the 3xx
                     status + Location directly, the more sensitive
                     mode for routing-bug detection).
  --check-body       Also compare response body bytes (SHA-256 hash).
                     Off by default — adds a full body read per side
                     per path. Required to catch silent schema drift
                     where two endpoints agree on status but differ on
                     payload (e.g. a JSON field dropped on one side).
  --check-headers <list>
                     Compare the named response headers (comma-separated,
                     case-insensitive). e.g. --check-headers content-type,cache-control
                     Catches policy drift like one side dropping
                     cache-control or returning a different CORS origin.
                     Reported before body drift.
  --check-exceptions Visit each path in a real browser (Chromium) and
                     compare uncaught JS errors + console.error
                     between sides. Catches React hydration mismatches
                     and other runtime-only bugs where HTTP looks
                     identical. Slow — one browser visit per side per
                     path. Requires \`playwright\` installed and a
                     browser binary available.
  --perf-delta-ms <n>  Flag a "perf" mismatch when right is more than
                     N ms slower than left. Single-sample wall clock —
                     noisy; set well above your jitter floor (or pair
                     with --perf-samples for percentile-based gating).
  --perf-ratio <n>   Flag a "perf" mismatch when right > left * N.
                     Composes with --perf-delta-ms via OR.
  --perf-samples <n> Number of serial fetches per side per path. Default
                     1 (single-sample). With N>1 the perf threshold runs
                     against the configured percentile of N samples
                     instead of a single noisy wall-clock reading. Each
                     sample is timed independently; the first captures
                     status/headers/body and later samples contribute
                     timing only. Worst-case wall-clock per side per
                     path is N * --timeout.
  --perf-percentile <p>
                     Which percentile to compare when --perf-samples>1.
                     One of min, median, p95, p99. Default p95 (SLO
                     standard). Ignored when --perf-samples=1.
  --timeout <ms>     Per-request timeout, applied per sample. Default 10000.
  --help             Show this help

Exit code is 1 when any mismatch is found, 0 when both sides agree on
every path. Useful as a CI gate: \`chaosbringer parity ... || exit 1\`.

Examples:
  chaosbringer parity --left http://localhost:3000 --right http://localhost:3001 \\
    --paths paths.txt --output parity.json
  echo "/" | chaosbringer parity --left http://a --right http://b --paths /dev/stdin
`;

function readPaths(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  return (
    text
      .split(/\r?\n/)
      // Strip inline `#` comments first — the unescaped `#` would later be
      // parsed as a URL fragment, silently dropping everything after it and
      // letting accidentally-correct results mask the parse failure. Doing
      // this before the empty-line filter keeps comment-only lines from
      // surviving as a stray empty path.
      .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
      .filter((line) => line.length > 0)
  );
}

export async function runParityCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      left: { type: "string" },
      right: { type: "string" },
      paths: { type: "string" },
      output: { type: "string" },
      "follow-redirects": { type: "boolean", default: false },
      "check-body": { type: "boolean", default: false },
      "check-headers": { type: "string" },
      "check-exceptions": { type: "boolean", default: false },
      "perf-delta-ms": { type: "string" },
      "perf-ratio": { type: "string" },
      "perf-samples": { type: "string" },
      "perf-percentile": { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.left || !values.right || !values.paths) {
    console.error("parity: --left, --right, and --paths are all required");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  const timeoutMs = values.timeout ? parseInt(values.timeout, 10) : undefined;
  const paths = readPaths(values.paths);
  if (paths.length === 0) {
    console.error("parity: no paths found in", values.paths);
    process.exitCode = 1;
    return;
  }

  const checkHeaders = values["check-headers"]
    ?.split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  let perfSamples: number | undefined;
  if (values["perf-samples"] !== undefined) {
    const n = parseInt(values["perf-samples"], 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`parity: --perf-samples must be a positive integer (got ${values["perf-samples"]})`);
      process.exitCode = 1;
      return;
    }
    perfSamples = n;
  }
  let perfPercentile: PerfPercentile | undefined;
  if (values["perf-percentile"] !== undefined) {
    const p = values["perf-percentile"];
    if (!(PERF_PERCENTILES as readonly string[]).includes(p)) {
      console.error(
        `parity: --perf-percentile must be one of ${PERF_PERCENTILES.join(", ")} (got ${p})`,
      );
      process.exitCode = 1;
      return;
    }
    perfPercentile = p as PerfPercentile;
  }

  const report = await runParity({
    left: values.left,
    right: values.right,
    paths,
    followRedirects: values["follow-redirects"],
    checkBody: values["check-body"],
    checkHeaders,
    checkExceptions: values["check-exceptions"],
    perfDeltaMs: values["perf-delta-ms"] ? parseFloat(values["perf-delta-ms"]) : undefined,
    perfRatio: values["perf-ratio"] ? parseFloat(values["perf-ratio"]) : undefined,
    perfSamples,
    perfPercentile,
    timeoutMs,
  });

  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, JSON.stringify(report, null, 2));
  }

  console.log(`Checked ${report.pathsChecked} path(s): ${report.matches.length} match, ${report.mismatches.length} mismatch.`);
  for (const m of report.mismatches) {
    // Print every detected kind for this probe, not just the primary —
    // a header drift can mask a body drift if we only show the first.
    for (const kind of m.kinds) {
      if (kind === "status") {
        console.log(`  STATUS ${m.path}  left=${m.left.status}  right=${m.right.status}`);
      } else if (kind === "redirect") {
        console.log(
          `  REDIR  ${m.path}  left→${m.left.location ?? "(none)"}  right→${m.right.location ?? "(none)"}`,
        );
      } else if (kind === "body") {
        const summary = summariseBodyDiff(m.bodyDiff);
        const head = `  BODY   ${m.path}  left=${m.left.bodyLength}B (${m.left.bodyHash?.slice(0, 8)}…)  right=${m.right.bodyLength}B (${m.right.bodyHash?.slice(0, 8)}…)`;
        console.log(summary ? `${head}\n         ${summary}` : head);
      } else if (kind === "header") {
        const diffs: string[] = [];
        const left = m.left.headers ?? {};
        const right = m.right.headers ?? {};
        for (const name of Object.keys(left)) {
          if (left[name] !== right[name]) {
            diffs.push(`${name}: left=${left[name] ?? "(none)"} right=${right[name] ?? "(none)"}`);
          }
        }
        console.log(`  HEADER ${m.path}  ${diffs.join(" | ")}`);
      } else if (kind === "exception") {
        const leftCount = (m.left.pageErrors?.length ?? 0) + (m.left.consoleErrors?.length ?? 0);
        const rightCount = (m.right.pageErrors?.length ?? 0) + (m.right.consoleErrors?.length ?? 0);
        const sample = (m.right.pageErrors ?? m.right.consoleErrors ?? m.left.pageErrors ?? m.left.consoleErrors ?? [])[0];
        console.log(
          `  EXC    ${m.path}  left=${leftCount} err  right=${rightCount} err  e.g. "${sample ?? "(none)"}"`,
        );
      } else if (kind === "perf") {
        // When N-sample mode is on, show the configured percentile
        // (the value the threshold actually compared) — otherwise the
        // printed numbers wouldn't explain why the mismatch fired.
        // Fall back to first-sample `durationMs` for single-sample mode.
        const pct = report.config.perfPercentile;
        const lStats = m.left.perfStats;
        const rStats = m.right.perfStats;
        const l = pct && lStats ? lStats[pct] : (m.left.durationMs ?? 0);
        const r = pct && rStats ? rStats[pct] : (m.right.durationMs ?? 0);
        const delta = r - l;
        const ratio = l > 0 ? r / l : 0;
        const tag = pct && lStats && rStats ? ` ${pct} of ${lStats.samples}/${rStats.samples}` : "";
        console.log(
          `  PERF   ${m.path}  left=${l.toFixed(0)}ms  right=${r.toFixed(0)}ms  Δ=${delta.toFixed(0)}ms (×${ratio.toFixed(2)})${tag}`,
        );
      } else if (kind === "failure") {
        const leftMsg = m.left.error ?? `status ${m.left.status}`;
        const rightMsg = m.right.error ?? `status ${m.right.status}`;
        console.log(`  FAIL   ${m.path}  left=${leftMsg}  right=${rightMsg}`);
      }
    }
  }

  // Non-zero exit on any mismatch — makes the subcommand usable as a CI gate
  // without an extra `jq` step on the output.
  if (report.mismatches.length > 0) process.exitCode = 1;
}
