/**
 * Telling "the site is down" apart from "the site is broken". A navigation
 * the browser could not even connect for fails with one of Chromium's
 * connection-level net errors, which Playwright puts in the message as
 * `page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/login`.
 * Such a failure says nothing about the scenario or recipe that met it, so
 * a load run stops on a streak of them instead of counting failures, and
 * `verifyAndPromote` does not record one against a recipe.
 */

/**
 * The net errors that mean no connection to the host was made: nothing
 * listens there, the name does not resolve, the address cannot be reached,
 * or the browser will not dial that port at all (`ERR_UNSAFE_PORT`: Chromium
 * refuses ports such as 1 or 6000 before connecting).
 */
const UNREACHABLE_NET_ERRORS = new Set([
  "ERR_ADDRESS_INVALID",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_FAILED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_UNSAFE_PORT",
]);

/**
 * The `net::ERR_… at <url>` part of `message` when it is a connection-level
 * failure of a navigation to `site`'s origin; `null` for any other failure,
 * and for a navigation to another origin (a payment provider being down is
 * not the site being down).
 */
export function unreachableNavigation(message: string, site: string): string | null {
  const m = /net::(ERR_[A-Z_]+) at (\S+)/.exec(message);
  if (!m || !UNREACHABLE_NET_ERRORS.has(m[1])) return null;
  const at = origin(m[2]);
  return at !== null && at === origin(site) ? m[0] : null;
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Iterations in a row, across every worker of a run, that failed because
 * the browser could not connect to `baseUrl`. Any other outcome, a success
 * or a failure the site answered for, resets it. `record` returns the reason
 * to stop the run with once the streak reaches `limit`.
 */
export class UnreachableStreak {
  private count = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly limit: number,
  ) {}

  /** `failure` is the message of the error that failed the iteration, `null` when it succeeded. */
  record(failure: string | null): string | null {
    const net = failure === null ? null : unreachableNavigation(failure, this.baseUrl);
    if (!net) {
      this.count = 0;
      return null;
    }
    this.count += 1;
    if (this.count < this.limit) return null;
    return `base URL unreachable: ${this.baseUrl} (${net}, ${this.count} iterations in a row)`;
  }
}
