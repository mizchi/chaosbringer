/**
 * GitHub Actions annotation emitter. Renders a run's error clusters + dead
 * links as `::error ...::` / `::warning ...::` workflow commands so GitHub
 * surfaces them on the PR Checks tab without requiring a separate bot.
 *
 * See: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 *
 * chaosbringer doesn't know source file locations (the failures are on URLs),
 * so `file=` is omitted. GitHub still renders the annotation; it just shows
 * up on the run summary instead of the diff.
 */

import type { CrawlReport } from "./types.js";

/** Escape newlines + carriage returns so a single annotation stays on one line. */
function escapeProperty(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function escapeMessage(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export interface AnnotationLine {
  level: "error" | "warning" | "notice";
  title: string;
  message: string;
}

/**
 * Decide which severity each error cluster deserves. Invariant violations and
 * network errors are errors; console errors / rejections are warnings; anything
 * else is a notice. Strict mode upgrades warnings to errors so the annotation
 * level matches `getExitCode` with `strict=true`.
 */
function levelForClusterType(type: CrawlReport["errorClusters"][number]["type"], strict: boolean): AnnotationLine["level"] {
  switch (type) {
    case "invariant-violation":
    case "network":
    case "exception":
    case "crash":
      return "error";
    case "console":
    case "unhandled-rejection":
      return strict ? "error" : "warning";
    default:
      return "notice";
  }
}

/**
 * Build the list of annotations for a report. Pure — the CLI just prints each
 * entry. Callers that want to inject into their own logger can use this.
 */
export function buildGithubAnnotations(
  report: CrawlReport,
  opts: { strict?: boolean } = {}
): AnnotationLine[] {
  const strict = opts.strict ?? false;
  const out: AnnotationLine[] = [];

  for (const cluster of report.errorClusters) {
    const count = cluster.count > 1 ? ` ×${cluster.count}` : "";
    const urls = cluster.urls.length > 0 ? ` (on ${cluster.urls.length} URL${cluster.urls.length > 1 ? "s" : ""})` : "";
    out.push({
      level: levelForClusterType(cluster.type, strict),
      title: `[${cluster.type}]${count} ${truncate(cluster.fingerprint, 80)}`,
      message: `${cluster.sample.message}${urls}`,
    });
  }

  const dead = report.summary.discovery?.deadLinks ?? [];
  for (const link of dead) {
    out.push({
      level: "error",
      title: `Dead link: ${truncate(link.url, 80)}`,
      message: `HTTP ${link.statusCode} — found on ${link.sourceUrl || "(initial)"}${link.sourceElement ? ` via ${truncate(link.sourceElement, 40)}` : ""}`,
    });
  }

  return out;
}

/** Serialize one annotation into its workflow-command text form. */
export function formatGithubAnnotation(a: AnnotationLine): string {
  return `::${a.level} title=${escapeProperty(a.title)}::${escapeMessage(a.message)}`;
}

/** Write every annotation to `sink` (default: console.log). */
export function printGithubAnnotations(
  report: CrawlReport,
  opts: { strict?: boolean; sink?: (line: string) => void } = {}
): void {
  const sink = opts.sink ?? ((s) => console.log(s));
  for (const a of buildGithubAnnotations(report, { strict: opts.strict })) {
    sink(formatGithubAnnotation(a));
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}
