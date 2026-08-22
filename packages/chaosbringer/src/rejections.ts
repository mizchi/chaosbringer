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
   * Returns `[]` rather than throwing when the page has navigated away or
   * closed: a dead page has no rejections to report, and turning that into an
   * error would fail runs for the wrong reason.
   */
  drain(): Promise<EscapedRejection[]>;
}

/**
 * Start capturing unhandled rejections on `page`.
 *
 * Installed as an init script, so **call this before you navigate** — on an
 * already-loaded page nothing is listening and `drain()` reports an honest but
 * useless empty list. It survives navigation, so one call covers a whole test.
 */
export async function watchUnhandledRejections(page: Page): Promise<RejectionWatcher> {
  await page.addInitScript(() => {
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
  });
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
    // Page navigated away or closed — nothing to report, and not an error.
    return [];
  }
}
