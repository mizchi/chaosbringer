/**
 * Telling "the site is down" apart from "the site is broken". A navigation
 * the browser could not even connect for fails with one of Chromium's
 * connection-level net errors, which Playwright puts in the message as
 * `page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4000/login`.
 * Such a failure says nothing about the scenario or recipe that met it, so
 * a load run stops on a streak of them instead of counting failures, and
 * `verifyAndPromote` does not record one against a recipe.
 */
import type { BrowserContext, Page, Request } from "playwright";

/**
 * The net errors that mean no connection to the host was made: nothing
 * listens there, the name does not resolve, the address cannot be reached,
 * or the browser will not dial that port at all (`ERR_UNSAFE_PORT`: Chromium
 * refuses ports such as 1 or 6000 before connecting). Not
 * `ERR_CONNECTION_RESET`: the host accepted that connection, and one that
 * sheds load by resetting some of them is still serving the rest.
 */
const UNREACHABLE_NET_ERRORS = new Set([
  "ERR_ADDRESS_INVALID",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_CONNECTION_FAILED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_UNSAFE_PORT",
]);

/**
 * The last document request a page's main frame sent, as
 * `watchDocumentRequests` saw it. The goto error names the URL navigated
 * to, not the host that failed: a site that answers `/checkout` with a
 * redirect to a host that is down fails it as
 * `net::ERR_CONNECTION_REFUSED at <site>/checkout` too.
 */
export interface DocumentRequest {
  /** The URL navigated to: the first request of the redirect chain. */
  url: string;
  /** The request followed a redirect: the site answered, and where it pointed failed. */
  redirected: boolean;
}

/**
 * Watches `target`'s main-frame navigations; the function returned gives the
 * last one sent, `null` before any. A request is announced before it can
 * fail, so the one a failed goto sent is the last when the goto rejects.
 */
export function watchDocumentRequests(target: Page | BrowserContext): () => DocumentRequest | null {
  let last: DocumentRequest | null = null;
  // A stand-in page without events, as unit tests of a scenario pass, has
  // none to watch: the message alone decides, as it did before.
  if (typeof target.on !== "function") return () => null;
  (target as Page).on("request", (request: Request) => {
    if (!request.isNavigationRequest() || !inMainFrame(request)) return;
    let first = request;
    for (let from = first.redirectedFrom(); from; from = from.redirectedFrom()) first = from;
    last = { url: first.url(), redirected: first !== request };
  });
  return () => last;
}

function inMainFrame(request: Request): boolean {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // A service worker's request has no frame.
    return false;
  }
}

/**
 * The `net::ERR_… at <url>` part of `message` when it is a connection-level
 * failure of a navigation to `site`'s origin; `null` for any other failure,
 * for a navigation to another origin (a payment provider being down is not
 * the site being down), and when `sent`, the page's last document request,
 * says the site answered that navigation with a redirect.
 */
export function unreachableNavigation(
  message: string,
  site: string,
  sent?: DocumentRequest | null,
): string | null {
  const net = netFailure(message);
  if (!net) return null;
  const at = origin(net.url);
  if (at === null || at !== origin(site)) return null;
  if (sent?.redirected && sameDocument(sent.url, net.url)) return null;
  return net.text;
}

/**
 * Whether `message` is the connection-level failure of a navigation to one
 * of `aborted`, the URLs a fault rule aborted: the run's own fault, not the
 * host.
 */
export function abortedNavigation(message: string, aborted: ReadonlyArray<string>): boolean {
  const net = netFailure(message);
  return net !== null && aborted.some((url) => sameDocument(url, net.url));
}

function netFailure(message: string): { text: string; url: string } | null {
  const m = /net::(ERR_[A-Z_]+) at (\S+)/.exec(message);
  return m && UNREACHABLE_NET_ERRORS.has(m[1]) ? { text: m[0], url: m[2] } : null;
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The same document: a request's URL has no fragment, a goto's message keeps it. */
function sameDocument(a: string, b: string): boolean {
  const document = (url: string) => {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.href;
    } catch {
      return url;
    }
  };
  return document(a) === document(b);
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

  /**
   * `failure` is the message of the error that failed the iteration, `null`
   * when it succeeded; `sent` the last document request of its page.
   */
  record(failure: string | null, sent?: DocumentRequest | null): string | null {
    const net = failure === null ? null : unreachableNavigation(failure, this.baseUrl, sent);
    if (!net) {
      this.count = 0;
      return null;
    }
    this.count += 1;
    if (this.count < this.limit) return null;
    return `base URL unreachable: ${this.baseUrl} (${net}, ${this.count} iterations in a row)`;
  }
}
