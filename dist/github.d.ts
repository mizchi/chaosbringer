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
export interface AnnotationLine {
    level: "error" | "warning" | "notice";
    title: string;
    message: string;
}
/**
 * Build the list of annotations for a report. Pure — the CLI just prints each
 * entry. Callers that want to inject into their own logger can use this.
 */
export declare function buildGithubAnnotations(report: CrawlReport, opts?: {
    strict?: boolean;
}): AnnotationLine[];
/** Serialize one annotation into its workflow-command text form. */
export declare function formatGithubAnnotation(a: AnnotationLine): string;
/** Write every annotation to `sink` (default: console.log). */
export declare function printGithubAnnotations(report: CrawlReport, opts?: {
    strict?: boolean;
    sink?: (line: string) => void;
}): void;
//# sourceMappingURL=github.d.ts.map