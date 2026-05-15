/**
 * `chaosbringer parity --left URL --right URL --paths file [--output file]`.
 * See `parity.ts` for design notes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { runParity } from "./parity.js";

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
  --timeout <ms>     Per-request timeout. Default 10000.
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

  const report = await runParity({
    left: values.left,
    right: values.right,
    paths,
    followRedirects: values["follow-redirects"],
    timeoutMs,
  });

  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, JSON.stringify(report, null, 2));
  }

  console.log(`Checked ${report.pathsChecked} path(s): ${report.matches.length} match, ${report.mismatches.length} mismatch.`);
  for (const m of report.mismatches) {
    if (m.kind === "status") {
      console.log(`  STATUS ${m.path}  left=${m.left.status}  right=${m.right.status}`);
    } else if (m.kind === "redirect") {
      console.log(`  REDIR  ${m.path}  left→${m.left.location ?? "(none)"}  right→${m.right.location ?? "(none)"}`);
    } else {
      const leftMsg = m.left.error ?? `status ${m.left.status}`;
      const rightMsg = m.right.error ?? `status ${m.right.status}`;
      console.log(`  FAIL   ${m.path}  left=${leftMsg}  right=${rightMsg}`);
    }
  }

  // Non-zero exit on any mismatch — makes the subcommand usable as a CI gate
  // without an extra `jq` step on the output.
  if (report.mismatches.length > 0) process.exitCode = 1;
}
