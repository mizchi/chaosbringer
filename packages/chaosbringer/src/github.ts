/**
 * GitHub Actions annotation emitter. Renders a run's error clusters, dead
 * links, off-site redirects and warnings (`report.warnings`) as `::error ...::` /
 * `::warning ...::` workflow commands so GitHub surfaces them on the PR
 * Checks tab without requiring a separate bot.
 *
 * See: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 *
 * chaosbringer doesn't know source file locations (the failures are on URLs),
 * so `file=` is omitted. GitHub still renders the annotation; it just shows
 * up on the run summary instead of the diff.
 */

import { describeOffsiteNavigation, distinctOffsiteNavigations, isOffsiteRedirect } from "./offsite-navigation.js";
import { clusterFailsRun, type ExitCodeOptions } from "./reporter.js";
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
 * Decide which severity each error cluster deserves: `error` when a rule of
 * the run fails it on that cluster (`clusterFailsRun`: invariant violations,
 * failed navigations and renderer crashes always; console errors and
 * rejections under `--strict`; network errors under `--fail-on-network`; a
 * console cluster of HTTP responses under the `--fail-on-http` it meets; a
 * cluster the baseline did not have under `--baseline-strict`), so the
 * annotation level matches the exit code. Exceptions stay `error` in every
 * mode, also on a run that exits 0. Otherwise a console error, rejection or
 * network error is a warning, and anything else a notice. A network error
 * used to be `error` on a run that exited 0.
 */
function levelForCluster(cluster: CrawlReport["errorClusters"][number], fails: (c: typeof cluster) => boolean): AnnotationLine["level"] {
  if (cluster.type === "exception" || fails(cluster)) return "error";
  switch (cluster.type) {
    case "console":
    case "unhandled-rejection":
    case "network":
      return "warning";
    default:
      return "notice";
  }
}

/**
 * Build the list of annotations for a report. Pure — the CLI just prints each
 * entry. Callers that want to inject into their own logger can use this.
 * `opts` are the run's exit rules (`getExitCode`'s), `strict` alone included.
 */
export function buildGithubAnnotations(
  report: CrawlReport,
  opts: ExitCodeOptions = {}
): AnnotationLine[] {
  const fails = clusterFailsRun(report, opts);
  const out: AnnotationLine[] = [];

  for (const cluster of report.errorClusters) {
    const count = cluster.count > 1 ? ` ×${cluster.count}` : "";
    const urls = cluster.urls.length > 0 ? ` (on ${cluster.urls.length} URL${cluster.urls.length > 1 ? "s" : ""})` : "";
    out.push({
      level: levelForCluster(cluster, fails),
      title: `[${cluster.type}]${count} ${truncate(cluster.fingerprint, 80)}`,
      message: `${cluster.sample.message}${urls}`,
    });
  }

  // `error` only when `--fail-on-dead-links` fails the run on them.
  const dead = report.summary.discovery?.deadLinks ?? [];
  for (const link of dead) {
    out.push({
      level: opts.deadLinks ? "error" : "warning",
      title: `Dead link: ${truncate(link.url, 80)}`,
      message: `HTTP ${link.statusCode} — found on ${link.sourceUrl || "(initial)"}${link.sourceElement ? ` via ${truncate(link.sourceElement, 40)}` : ""}`,
    });
  }

  // A page that redirected off-site on its own, each `from -> to` once.
  // The run fails on it only through an invariant (`noOffsiteRedirect`),
  // whose violation is already an `error` above and names the page's
  // redirects: a page with one is left to it. Otherwise a warning when the
  // target came from the page's own URL (an open redirect), a notice when
  // it did not (a /chat that sends users to a chat service, an SSO the
  // check allowed).
  for (const page of report.pages) {
    if (page.errors.some((e) => e.type === "invariant-violation" && e.offsiteRedirect)) continue;
    for (const nav of distinctOffsiteNavigations((page.offsiteNavigations ?? []).filter(isOffsiteRedirect))) {
      out.push({
        level: nav.reflected ? "warning" : "notice",
        title: `Off-site redirect: ${truncate(nav.from, 80)}`,
        message: describeOffsiteNavigation(nav),
      });
    }
  }

  // The setup problems (`report.warnings`): `error` only when
  // `--fail-on-warnings` fails the run on them, as for dead links.
  for (const w of report.warnings ?? []) {
    out.push({
      level: opts.warnings ? "error" : "warning",
      title: `chaosbringer warning: ${w.code}`,
      message: `${w.message}${w.count > 1 ? ` (×${w.count})` : ""}`,
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
  opts: ExitCodeOptions & { sink?: (line: string) => void } = {}
): void {
  const { sink = (s) => console.log(s), ...exit } = opts;
  for (const a of buildGithubAnnotations(report, exit)) {
    sink(formatGithubAnnotation(a));
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}
