// Artifact naming shared by the runner edges (test-edge.ts, cli.ts). Internal:
// not a tsup entry and not exported from core. scripts/*.mjs keep their own
// copies of these patterns (they only read the files, from dist/core.js).
import path from "node:path";

/** Replace every run of non-letter/digit/underscore characters with `_`. */
export function slugify(s: string): string {
  return s.replace(/[^\p{L}\p{N}_]+/gu, "_");
}

const KIND_SUFFIX = { report: ".json", trace: ".trace.json", coverage: ".coverage.json" } as const;

/** `<outDir>/<slug>.<runTag>{.json,.trace.json,.coverage.json}` */
export function runArtifactPath(
  outDir: string,
  slug: string,
  runTag: string,
  kind: keyof typeof KIND_SUFFIX,
): string {
  return path.join(outDir, `${slug}.${runTag}${KIND_SUFFIX[kind]}`);
}

/** A per-run report file name (`<slug>.run<N>.json`); trace / coverage files do not match. */
export const RUN_REPORT_RE = /\.run\d+\.json$/;

/** The slug of a per-run report file name (`<slug>.run<N>.json` → `<slug>`). */
export function slugOfRunReport(file: string): string {
  return file.replace(RUN_REPORT_RE, "");
}
