/**
 * `chaosbringer journey --left URL --right URL --steps <file>`. See
 * `journey.ts` for design notes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { summariseBodyDiff } from "./body-diff.js";
import { runJourney, type JourneyStep } from "./journey.js";

const HELP = `Usage: chaosbringer journey --left <url> --right <url> --steps <file> [options]

Replay a sequence of HTTP requests against two base URLs and compare
each step's response. Per-side cookie jar carries state from POST to
subsequent GET, so a silently-dropped write surfaces in the read step's
body diff. The bug class single-shot parity can't see.

Steps file is JSON. Either a bare array of steps or
\`{ "steps": [...] }\` is accepted:

  [
    { "method": "POST", "path": "/api/todos", "body": { "title": "x" }, "label": "create" },
    { "method": "GET",  "path": "/api/todos", "label": "list-after-create" }
  ]

Required:
  --left <url>          First base URL
  --right <url>         Second base URL
  --steps <file>        Path to the JSON steps file (or "-" for stdin)

Options:
  --output <file>       Write the full report (JSON) to this path
  --check-headers <list>  Compare named headers per step (comma-separated)
  --no-check-body       Skip body comparison (defaults to on for journeys)
  --perf-delta-ms <n>   Flag a "perf" mismatch when right is more than
                        N ms slower than left on any step. Single-sample.
  --perf-ratio <n>      Flag a "perf" mismatch when right > left * N.
                        Composes with --perf-delta-ms via OR.
  --stop-on-mismatch    Stop at the first divergence (later steps depend
                        on earlier ones succeeding; no point continuing
                        a broken flow)
  --timeout <ms>        Per-request timeout. Default 10000
  --help                Show this help

Exit code is 1 when any step diverges, 0 when every step matches.
Useful as a CI gate for canary-vs-prod or v1-vs-v2 comparisons.

Example:
  chaosbringer journey \\
    --left http://localhost:3000 --right http://localhost:3001 \\
    --steps tests/checkout-flow.json --output reports/checkout-parity.json
`;

function readSteps(file: string): JourneyStep[] {
  const text = file === "-" ? readFileSync(0, "utf-8") : readFileSync(file, "utf-8");
  const parsed = JSON.parse(text);
  const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(
      `journey: ${file} is not a steps file — expected an array or { "steps": [...] }`,
    );
  }
  // Lightweight shape validation. We don't pull in a schema library —
  // bad inputs throw with a step index so the operator can find them.
  steps.forEach((s, i) => {
    if (typeof s !== "object" || s === null) {
      throw new Error(`journey: step ${i} is not an object`);
    }
    if (typeof s.method !== "string" || typeof s.path !== "string") {
      throw new Error(`journey: step ${i} missing method/path`);
    }
  });
  return steps as JourneyStep[];
}

export async function runJourneyCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      left: { type: "string" },
      right: { type: "string" },
      steps: { type: "string" },
      output: { type: "string" },
      "check-headers": { type: "string" },
      "no-check-body": { type: "boolean", default: false },
      "perf-delta-ms": { type: "string" },
      "perf-ratio": { type: "string" },
      "stop-on-mismatch": { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.left || !values.right || !values.steps) {
    console.error("journey: --left, --right, and --steps are all required");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  const steps = readSteps(values.steps);
  if (steps.length === 0) {
    console.error("journey: steps file has no steps");
    process.exitCode = 1;
    return;
  }
  const checkHeaders = values["check-headers"]
    ?.split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const report = await runJourney({
    left: values.left,
    right: values.right,
    steps,
    timeoutMs: values.timeout ? parseInt(values.timeout, 10) : undefined,
    checkBody: !values["no-check-body"],
    checkHeaders,
    perfDeltaMs: values["perf-delta-ms"] ? parseFloat(values["perf-delta-ms"]) : undefined,
    perfRatio: values["perf-ratio"] ? parseFloat(values["perf-ratio"]) : undefined,
    stopOnMismatch: values["stop-on-mismatch"],
  });

  if (values.output) {
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, JSON.stringify(report, null, 2));
  }

  console.log(
    `Ran ${report.stepsChecked}/${steps.length} step(s): ${report.matches.length} match, ${report.mismatches.length} mismatch.`,
  );
  for (const m of report.mismatches) {
    const prefix = `  [${m.index}] ${m.label}`;
    for (const kind of m.kinds) {
      if (kind === "status") {
        console.log(`${prefix}  STATUS left=${m.left.status} right=${m.right.status}`);
      } else if (kind === "redirect") {
        console.log(
          `${prefix}  REDIR  left→${m.left.location ?? "(none)"}  right→${m.right.location ?? "(none)"}`,
        );
      } else if (kind === "header") {
        const diffs: string[] = [];
        const left = m.left.headers ?? {};
        const right = m.right.headers ?? {};
        for (const name of Object.keys(left)) {
          if (left[name] !== right[name]) {
            diffs.push(`${name}: left=${left[name] ?? "(none)"} right=${right[name] ?? "(none)"}`);
          }
        }
        console.log(`${prefix}  HEADER ${diffs.join(" | ")}`);
      } else if (kind === "body") {
        const summary = summariseBodyDiff(m.bodyDiff);
        const head = `${prefix}  BODY   left=${m.left.bodyLength}B (${m.left.bodyHash?.slice(0, 8)}…)  right=${m.right.bodyLength}B (${m.right.bodyHash?.slice(0, 8)}…)`;
        console.log(summary ? `${head}\n         ${summary}` : head);
      } else if (kind === "perf") {
        const l = m.left.durationMs ?? 0;
        const r = m.right.durationMs ?? 0;
        const delta = r - l;
        const ratio = l > 0 ? r / l : 0;
        console.log(
          `${prefix}  PERF   left=${l.toFixed(0)}ms  right=${r.toFixed(0)}ms  Δ=${delta.toFixed(0)}ms (×${ratio.toFixed(2)})`,
        );
      } else if (kind === "failure") {
        const leftMsg = m.left.error ?? `status ${m.left.status}`;
        const rightMsg = m.right.error ?? `status ${m.right.status}`;
        console.log(`${prefix}  FAIL   left=${leftMsg} right=${rightMsg}`);
      }
    }
  }

  if (report.mismatches.length > 0) process.exitCode = 1;
}
