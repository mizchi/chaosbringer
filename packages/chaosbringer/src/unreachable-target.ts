/**
 * A crawl of a site that is not there. Pointed at a server that is not
 * running, the crawl recorded the start page's failed `page.goto` and
 * finished: `flake` called that one failure a stable cluster and exited 0,
 * `scan` suggested a single-page app or a bot check, and the crawl's own
 * exit 1 read as "the site has a bug". `crawl`, `flake` and `scan` refuse
 * such a run instead: one `could not reach <url>: is the server running?`
 * line and exit 2, as for any other run that could not be made.
 *
 * Which failures count is `load`'s list (`unreachableNavigation`): the net
 * errors that mean no connection to the host was made.
 */
import { unreachableNavigation } from "./load/unreachable.js";
import type { CrawlReport, NetworkProfile } from "./types.js";

export interface UnreachableTarget {
  /** The start URL the crawl could not reach. */
  url: string;
  /** The net error, as Playwright wrote it: `net::ERR_CONNECTION_REFUSED at <url>`. */
  reason: string;
}

/**
 * The start URL and its net error when `report`'s crawl reached nothing: no
 * page loaded, and the start page's navigation failed because no
 * connection to the site's origin was made. `null` for any other crawl,
 * one where a page loaded, one where the host answered (a reset or empty
 * response is the site's finding, and so is a start URL that redirected to
 * a host that is down: `PageError.redirected`), and one where the run cut
 * the connection itself: a fault rule fired (an `abort` the run injected
 * fails the same way), or `run.network` is `offline`
 * (`ERR_INTERNET_DISCONNECTED` is what that profile is for).
 */
export function unreachableTarget(
  report: Pick<CrawlReport, "baseUrl" | "pages" | "faultInjections">,
  run: { network?: NetworkProfile } = {},
): UnreachableTarget | null {
  const start = report.pages[0];
  if (!start) return null;
  if (run.network === "offline") return null;
  if (report.pages.some((p) => p.status !== "error" && p.status !== "timeout")) return null;
  if ((report.faultInjections ?? []).some((f) => f.injected > 0)) return null;
  for (const e of start.errors) {
    if (e.type !== "navigation" || e.redirected) continue;
    const reason = unreachableNavigation(e.message, report.baseUrl);
    if (reason) return { url: start.url, reason };
  }
  return null;
}

/** `could not reach <url>: is the server running? (<net error>)` */
export function unreachableTargetMessage(target: UnreachableTarget): string {
  return `could not reach ${target.url}: is the server running? (${target.reason})`;
}

/**
 * Thrown by `flake` and the scan CLI for an `unreachableTarget` crawl; the
 * CLI prints `chaosbringer <sub>: <message>` and exits 2.
 */
export class UnreachableTargetError extends Error {
  readonly target: UnreachableTarget;
  constructor(target: UnreachableTarget) {
    super(unreachableTargetMessage(target));
    this.name = "UnreachableTargetError";
    this.target = target;
  }
}

export function isUnreachableTargetError(err: unknown): err is UnreachableTargetError {
  return err instanceof UnreachableTargetError;
}
