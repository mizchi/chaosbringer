/**
 * External-navigation blocking without a Playwright route.
 *
 * `page.route` would do the job, but Playwright turns the browser HTTP cache
 * off (`Network.setCacheDisabled`) on any page that has a route, because a
 * response served from cache never reaches the route handler. Since
 * `blockExternalNavigation` is on by default, routing every page for it meant
 * every page of every crawl was measured cold: a repeat visit re-downloaded
 * every asset, and a site's caching headers could not be observed at all.
 *
 * Only navigations need to be looked at here, so this pauses document requests
 * alone, with CDP's Fetch domain on the page's own session:
 * `Fetch.enable({ patterns: [{ resourceType: "Document" }] })`. Nothing else is
 * paused and the cache stays on. The one thing this guard cannot do is see
 * every request — so fault injection and `traceparent`, which must, still
 * install the route (and lose the cache, which is inherent to them).
 *
 * Coverage matches the route it replaces:
 * - main-frame and same-process subframe navigations are paused on the page's
 *   session;
 * - an out-of-process iframe (site isolation: headed Chromium, a real Chrome
 *   over CDP, `--site-per-process`) runs its later navigations on its own
 *   target, so the guard attaches a session to each such frame as it commits
 *   (`context.newCDPSession(frame)` only succeeds for OOPIFs). The navigation
 *   that *creates* the OOPIF is still decided by the parent's session. A frame
 *   that navigates in the instant between its commit and the guard's
 *   `Fetch.enable` on it can slip through; Playwright's own route closes that
 *   gap by holding new targets paused, which a second client cannot do;
 * - a redirect hop is let through, as Playwright's route does (it never routes
 *   redirects): the guard decides on the URL the navigation was started for;
 * - popups (`window.open`, `target=_blank`) are other pages and are covered by
 *   neither.
 */

import type { CDPSession, Frame, Page } from "playwright";
import { pageCdp } from "./page-cdp.js";

/** The subset of `Fetch.requestPaused` this guard reads. */
interface RequestPaused {
  requestId: string;
  request: { url: string };
  redirectedRequestId?: string;
}

export interface NavigationGuardOptions {
  /** Whether a document request for `url` leaves the crawl. */
  isExternal(url: string): boolean;
  /** Called once per blocked navigation, before the request is failed. */
  onBlocked(url: string): void;
}

export interface NavigationGuard {
  /**
   * Stop pausing documents and drop every session the guard opened. Only
   * needed for a page that outlives the crawl (CDP attach mode); a closed page
   * takes its sessions with it.
   */
  dispose(): Promise<void>;
}

const DOCUMENT_PATTERNS = { patterns: [{ resourceType: "Document" as const, requestStage: "Request" as const }] };

/** Pause document requests on `client` and answer each through `options`. */
async function guardSession(client: CDPSession, options: NavigationGuardOptions): Promise<() => void> {
  const onPaused = (event: RequestPaused) => {
    const url = event.request.url;
    // A redirect hop is decided by the request it continues, as with the route.
    if (!event.redirectedRequestId && options.isExternal(url)) {
      options.onBlocked(url);
      client.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
      return;
    }
    client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
  };
  client.on("Fetch.requestPaused", onPaused);
  try {
    await client.send("Fetch.enable", DOCUMENT_PATTERNS);
  } catch (err) {
    client.off("Fetch.requestPaused", onPaused);
    throw err;
  }
  return () => client.off("Fetch.requestPaused", onPaused);
}

/**
 * Install the guard on `page`. Throws when the page has no CDP (a non-Chromium
 * page handed to `testPage`); the caller falls back to a route then.
 */
export async function installNavigationGuard(page: Page, options: NavigationGuardOptions): Promise<NavigationGuard> {
  const main = await pageCdp(page).session();
  const offMain = await guardSession(main, options);

  // One session per out-of-process frame, replaced on every commit: a frame
  // that left its process and came back has a dead session, and there is no
  // cheaper test for "is this frame an OOPIF now" than trying to attach.
  const frames = new Map<Frame, CDPSession>();
  const release = (frame: Frame) => {
    const session = frames.get(frame);
    frames.delete(frame);
    session?.detach().catch(() => {});
  };
  const onFrameNavigated = async (frame: Frame) => {
    if (frame === page.mainFrame()) return;
    const previous = frames.get(frame);
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(frame);
    } catch {
      // In the parent's process: the parent's session already covers it. Drop
      // the session it had as an OOPIF, unless a concurrent commit replaced it.
      if (frames.get(frame) === previous) release(frame);
      return;
    }
    try {
      await guardSession(session, options);
    } catch {
      session.detach().catch(() => {});
      return;
    }
    if (frame.isDetached()) {
      session.detach().catch(() => {});
      return;
    }
    // Read again rather than trusting `previous`: a second commit on the same
    // frame may have attached while this one was awaiting.
    const stale = frames.get(frame);
    frames.set(frame, session);
    if (stale && stale !== session) stale.detach().catch(() => {});
  };
  page.on("framenavigated", onFrameNavigated);
  page.on("framedetached", release);

  return {
    async dispose() {
      page.off("framenavigated", onFrameNavigated);
      page.off("framedetached", release);
      for (const frame of [...frames.keys()]) release(frame);
      offMain();
      await main.send("Fetch.disable").catch(() => {});
    },
  };
}
