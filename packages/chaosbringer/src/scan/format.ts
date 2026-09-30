/**
 * The human-readable side of a scan: the Markdown report written next to
 * the JSON, and the short terminal summary.
 */

import { SCAN_FAULT_LABELS, type ScanAnalysis, type ScanFaultKind, type ScanFinding, type ScanSeverity } from "./analyze.js";
import type { ScanEndpoint } from "./endpoints.js";

/** Where a perf-patterns catalog entry lives, for the report's links. */
export const PERF_PATTERN_URL = "https://github.com/mizchi/chaosbringer/blob/main/examples/perf-patterns/src/patterns";

export interface ScanSummaryInput {
  url: string;
  startedAt: string;
  durationMs: number;
  pagesVisited: number;
  actions: number;
  /** Absent when the chaos crawls were turned off; `runs` is empty when no endpoint was found. */
  chaos?: { runs: Array<{ fault: ScanFaultKind; pagesVisited: number; faultsInjected: number }>; endpoints: ScanEndpoint[] };
  files: { baseline: string; chaos: Partial<Record<ScanFaultKind, string>>; perfDir: string };
}

const ICON: Record<ScanSeverity, string> = { high: "🔴", medium: "🟠", low: "🟡" };

export function formatScanMarkdown(analysis: ScanAnalysis, s: ScanSummaryInput): string {
  const lines: string[] = [];
  lines.push(`# chaosbringer scan: ${s.url}`, "");
  lines.push(
    `Scanned ${s.startedAt} in ${Math.round(s.durationMs / 1000)}s: ${s.pagesVisited} page${s.pagesVisited === 1 ? "" : "s"}, ${s.actions} action${s.actions === 1 ? "" : "s"}.`,
  );
  if (!s.chaos) {
    lines.push("Chaos crawls: off (`--no-chaos`).");
  } else if (s.chaos.runs.length === 0) {
    lines.push("Chaos crawls: skipped — the clean crawl saw no same-site fetch / XHR request to inject faults on.");
  } else {
    const n = s.chaos.endpoints.length;
    lines.push(
      `Chaos crawls, every request to ${n} API endpoint${n === 1 ? "" : "s"} seen in the clean crawl failing: ` +
        s.chaos.runs.map((r) => `${SCAN_FAULT_LABELS[r.fault]} (${r.pagesVisited} pages, ${r.faultsInjected} injected)`).join(", ") +
        ".",
    );
  }
  lines.push("");
  const { high, medium, low } = analysis.counts;
  lines.push(`**${analysis.findings.length} finding${analysis.findings.length === 1 ? "" : "s"}**: ${ICON.high} ${high} high · ${ICON.medium} ${medium} medium · ${ICON.low} ${low} low`, "");
  for (const w of analysis.coverageWarnings) lines.push(`> ⚠️ ${w}`, "");
  for (const e of analysis.environment) {
    const hosts = e.hosts.length > 0 ? ` (${e.hosts.join(", ")})` : "";
    lines.push(
      `> Not counted: ${e.count} error${e.count === 1 ? "" : "s"} with \`${e.code}\`${hosts}: ${e.reason}.`,
      "",
    );
  }
  lines.push(
    "Findings are signals to look at, not verdicts: the perf rules are thresholds (Web Vitals' own bounds where one exists), measured once on this machine. Re-run to see what is stable.",
    "",
  );

  if (analysis.findings.length > 0) {
    lines.push("| | category | finding | where | seen |", "|---|---|---|---|---|");
    analysis.findings.forEach((f, i) => {
      lines.push(`| ${ICON[f.severity]} | ${f.category} | [${escapeCell(f.title)}](#${anchor(i)}) | ${escapeCell(shortWhere(f))} | ${f.occurrences} |`);
    });
    lines.push("");
    analysis.findings.forEach((f, i) => lines.push(...findingSection(f, i)));
  }

  if (s.chaos && s.chaos.runs.length > 0) {
    lines.push("## Endpoints the chaos crawl targeted", "");
    for (const e of s.chaos.endpoints) lines.push(`- \`${e.label}\` (${e.count}× in the clean crawl)`);
    lines.push("");
  }

  lines.push("## Files", "");
  lines.push(`- clean crawl report: \`${s.files.baseline}\``);
  for (const [kind, path] of Object.entries(s.files.chaos)) {
    lines.push(`- chaos crawl report (${SCAN_FAULT_LABELS[kind as ScanFaultKind]}): \`${path}\``);
  }
  lines.push(`- per-page perf sidecars: \`${s.files.perfDir}\``);
  lines.push(
    "",
    "Drill into a step with `chaosbringer perf drilldown`, compare two scans' perf with `chaosbringer perf regress`, and reproduce a crawl with the `reproCommand` in its report.",
    "",
  );
  return lines.join("\n");
}

function findingSection(f: ScanFinding, i: number): string[] {
  const out = [`<a id="${anchor(i)}"></a>`, `### ${ICON[f.severity]} ${f.title}`, ""];
  out.push(`\`${f.rule}\` · ${f.category} · ${f.severity} · seen ${f.occurrences}×`, "");
  for (const e of f.evidence) out.push(`- ${e}`);
  if (f.occurrences > f.evidence.length) out.push(`- … and ${f.occurrences - f.evidence.length} more`);
  out.push("", f.hint, "");
  if (f.patterns && f.patterns.length > 0) {
    out.push(`Catalog patterns with this signal: ${f.patterns.map((p) => `[${p}](${PERF_PATTERN_URL}/${p}.ts)`).join(", ")}`, "");
  }
  return out;
}

/** The terminal summary: counts, then one line per finding. */
export function formatScanSummary(analysis: ScanAnalysis, max = 20): string {
  const { high, medium, low } = analysis.counts;
  const lines = [`scan: ${analysis.findings.length} findings (${high} high, ${medium} medium, ${low} low)`];
  for (const w of analysis.coverageWarnings) lines.push(`  ⚠️  ${w}`);
  for (const f of analysis.findings.slice(0, max)) {
    lines.push(`  ${ICON[f.severity]} [${f.category}] ${f.title} — ${shortWhere(f)}`);
  }
  if (analysis.findings.length > max) lines.push(`  … ${analysis.findings.length - max} more in the report`);
  return lines.join("\n");
}

function shortWhere(f: ScanFinding): string {
  const first = f.where[0] ?? "";
  return f.occurrences > 1 ? `${first} (+${f.occurrences - 1})` : first;
}

function anchor(i: number): string {
  return `f${i + 1}`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
