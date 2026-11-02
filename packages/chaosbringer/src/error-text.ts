/**
 * What an error message carries that is not the error: Playwright's colours
 * and call log, and the crawler's own navigation calls failing. Shared by
 * the crawler (what it stores), `fingerprintError` (what a cluster key is),
 * the JUnit writer, the diff (reading an older baseline) and the scan.
 */

/**
 * One ANSI escape sequence (CSI: `ESC [ … final byte`). Playwright colours
 * the call log it appends to an error message (`\x1b[2m … \x1b[22m`).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
export const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g; // oxlint-disable-line no-control-regex

/** `s` without ANSI escape sequences. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, "");
}

/**
 * `message` up to Playwright's `\nCall log:`, the log of what the call was
 * doing when it failed. The log names the call's options (the `waitUntil`
 * the crawl's `--settle` picked), so the same failure under another settle
 * mode read as another error. It is diagnostics, kept on the stack.
 */
export function withoutCallLog(message: string): string {
  const at = message.indexOf("\nCall log:");
  return at === -1 ? message : message.slice(0, at).trimEnd();
}

/**
 * A Playwright navigation call failing (`page.goto: Timeout 30000ms
 * exceeded`, `page.goto: net::ERR_EMPTY_RESPONSE at …`): the crawler's own
 * call, not an error the page threw. Before the `navigation` type, the
 * crawler recorded these as `exception`; `diffReports` reads an older
 * baseline's with this.
 */
export const CRAWLER_NAVIGATION_ERROR =
  /^(?:page\.(?:goto|reload|goBack|goForward|waitForNavigation|waitForLoadState):|Navigation to .* is interrupted)/;

/** The message the crawler records for a renderer crash (`PageError.type: "crash"`). */
export const RENDERER_CRASHED = "renderer crashed";

/**
 * How a Playwright call that met a crashed page fails
 * (`page.waitForTimeout: Page crashed`, `page.evaluate: Target crashed`):
 * what an older version recorded as an `exception` for a renderer crash.
 */
export const CRASHED_PAGE_ERROR = /^[\w.]+: (?:Page|Target) crashed\b/;
