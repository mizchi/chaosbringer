/**
 * `chaosbringer cluster-artifacts <report.json> --bundle-dir <dir>` —
 * post-hoc cluster bundle generator. See `cluster-artifacts.ts` for
 * design notes.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writeClusterArtifacts } from "./cluster-artifacts.js";
import type { CrawlReport } from "./types.js";

const HELP = `Usage: chaosbringer cluster-artifacts <report.json> --bundle-dir <dir> [options]

Generate one representative artifact bundle per error cluster, drawing
from an existing failure-artifacts directory. Outputs to
<bundle-dir>/clusters/<sanitised-key>/ by default.

Each cluster bundle contains:
  - errors.json   filtered to just this cluster's errors
  - info.json     cluster metadata + which page bundle it copied from
  - page.html, trace.jsonl, repro.sh, screenshot.png   (if available
                  in the representative page's bundle)

Options:
  --bundle-dir <dir>   Directory of per-page failure bundles (required)
  --output-dir <dir>   Where to write cluster bundles (default <bundle-dir>/clusters)
  --max-clusters <n>   Cap on number of cluster bundles emitted
  --min-count <n>      Skip clusters whose count is below n (default 1)
  --json               Print a JSON summary instead of a human-readable one
  --help               Show this help

Examples:
  chaosbringer cluster-artifacts chaos-report.json --bundle-dir ./artifacts
  chaosbringer cluster-artifacts report.json --bundle-dir ./artifacts --min-count 5
`;

export async function runClusterArtifactsCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "bundle-dir": { type: "string" },
      "output-dir": { type: "string" },
      "max-clusters": { type: "string" },
      "min-count": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 1) {
    console.error("cluster-artifacts: expected exactly one report path");
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (!values["bundle-dir"]) {
    console.error("cluster-artifacts: --bundle-dir is required");
    process.exitCode = 1;
    return;
  }

  const reportPath = positionals[0];
  let report: CrawlReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8")) as CrawlReport;
  } catch (err) {
    throw new Error(`failed to read report ${reportPath}: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(report.errorClusters)) {
    throw new Error(`${reportPath} is not a chaos report (no errorClusters array)`);
  }

  const results = writeClusterArtifacts(report, {
    bundleDir: values["bundle-dir"],
    outputDir: values["output-dir"],
    maxClusters: values["max-clusters"] ? parseInt(values["max-clusters"], 10) : undefined,
    minCount: values["min-count"] ? parseInt(values["min-count"], 10) : undefined,
  });

  if (values.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  console.log(`Wrote ${results.length} cluster bundle(s).`);
  for (const r of results) {
    const note = r.representativeBundleFound
      ? `copied [${r.copiedFiles.join(", ")}]`
      : "no per-page bundle found — wrote errors.json + info.json only";
    console.log(`  ${r.clusterKey}`);
    console.log(`    → ${r.bundlePath}`);
    console.log(`    representative: ${r.representativeUrl ?? "(none)"}  ${note}`);
  }
}
