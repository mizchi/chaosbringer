/**
 * Catching the rejections an app lets escape, on a page you drive yourself.
 *
 * This is half of any timeout or error-path oracle: "the spinner stopped" and
 * "the spinner stopped *and* nothing escaped" are different findings, and the
 * second one is usually the bug. The crawler has always captured these; three
 * separate readers writing their own harness needed the same thing and had to
 * reconstruct it from a comment in `dist/`, including the part that is easy to
 * get wrong — `preventDefault()`.
 *
 * Without that call Chromium reports the same rejection a second time through
 * `page.on("pageerror")`, so a harness listening to both counts one escape as
 * two, and classifies a rejection as a thrown exception.
 */
import type { Page } from "playwright";

/** One rejection the page let escape every handler. */
export interface EscapedRejection {
  message: string;
  stack?: string;
}

export interface RejectionWatcher {
  /**
   * Rejections captured since the last call. Reading empties the buffer, so
   * two consecutive drains do not report the same escape twice — which is what
   * you want when you probe once at a deadline and again after a quiescence
   * window.
   *
   * Returns `[]` rather than throwing when the page has closed under you. That
   * is a genuine loss, not a clean result: escapes already in the bag go with
   * it, and there is no longer anywhere to read them from. It is not raised as
   * an error because a page closing is usually reported by whatever closed it,
   * and failing the run here would name the wrong cause.
   */
  drain(): Promise<EscapedRejection[]>;
}

/**
 * The listener, as one function used two ways: as an init script for every
 * future navigation, and evaluated once against the document that is already
 * open. Both installs run the same code, because the alternative — a second
 * copy for the already-loaded case — is how one of them ends up without the
 * `preventDefault`.
 */
function installRejectionCapture(): void {
  const w = window as unknown as { __chaosRejections?: EscapedRejection[] };
  if (w.__chaosRejections !== undefined) return; // idempotent per frame
  w.__chaosRejections = [];
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    w.__chaosRejections?.push({
      message: reason?.message || String(event.reason),
      ...(reason?.stack !== undefined ? { stack: reason.stack } : {}),
    });
    // Claim it, so it does not also arrive as `pageerror` and get counted
    // twice — once as a rejection and once as a thrown exception.
    event.preventDefault();
  });
}

/**
 * Start capturing unhandled rejections on `page`. Survives navigation, so one
 * call covers a whole test, and it does not matter whether the page has loaded
 * yet.
 *
 * That last part used to be a trap: the listener went in only as an init
 * script, so calling this *after* navigating left nothing listening and
 * `drain()` returned `[]` — measured on a page that escapes a rejection on
 * demand, an empty result while the escape happened. The docstring called that
 * "an honest but useless empty list", which it is not: `[]` is the same answer
 * a clean page gives, so a caller who got the order wrong was told their app
 * was fine. Documenting a trap is not the same as not having one, so the
 * listener is now also evaluated against the current document.
 */
export async function watchUnhandledRejections(page: Page): Promise<RejectionWatcher> {
  await page.addInitScript(installRejectionCapture);
  try {
    await page.evaluate(installRejectionCapture);
  } catch {
    // No document to install into yet (or it went away). The init script
    // covers every navigation from here, which is the common case and the one
    // the crawler uses.
  }
  return { drain: () => drainRejections(page) };
}

/** The read half, so the crawler and `watchUnhandledRejections` share one copy. */
export async function drainRejections(page: Page): Promise<EscapedRejection[]> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as { __chaosRejections?: EscapedRejection[] };
      const bag = w.__chaosRejections ?? [];
      w.__chaosRejections = [];
      return bag;
    });
  } catch {
    // The page is gone. Anything still in the bag is lost with it — this is a
    // read that could not happen, not a page with nothing to report. Callers
    // who need to tell those apart have to observe the page closing; there is
    // nothing left here to ask.
    return [];
  }
}
