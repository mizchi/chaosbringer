/**
 * The lightbringer session glue that the crawler's `PagePerf` and the load
 * runner's `StepPerf` share: opening a session on the page's shared CDP
 * session, ending a span and telling whether it was recorded, and racing a
 * call that may hang against a timeout (`raceTimeout`, from `./async-util.js`).
 *
 * A leaf module: it imports only lightbringer/core and `./page-cdp.js`, so
 * both `perf.ts` and `load/step-perf.ts` can use it without either importing
 * the other.
 */

import type { CDPSession, Page } from "playwright";
import {
  startSession,
  type PerfSession,
  type SessionOptions,
  type SpanHandle,
} from "lightbringer/core";
import { pageCdp } from "./page-cdp.js";

/**
 * How long `finish()` may take before the page is given up on. lightbringer
 * bounds its in-page reads (`evaluateTimeoutMs`), but not every call
 * `finish()` makes goes through that bound: stopping JS/CSS coverage
 * (`--perf-cov`) and a forced GC (`--perf-mem`, when the load span is closed
 * here) are CDP calls that need the renderer's main thread, and on a page
 * whose main thread never yields they never answer. A crawl must not hang
 * on measurement, so the whole of `finish()` is raced against this.
 */
export const FINISH_TIMEOUT_MS = 15_000;

/**
 * Session options without CPU and network throttling: the crawler owns both
 * (`faults.cpu()`, `network`), and a load run's belong to its faults.
 * lightbringer applying its own would overwrite them on the same CDP session,
 * so the type does not let a caller pass them.
 */
export type PerfSessionOptions = Omit<SessionOptions, "cpuRate" | "netProfile">;

/** Open a lightbringer session on `page`'s shared CDP session. */
export async function openPerfSession(
  page: Page,
  opts: PerfSessionOptions,
): Promise<{ client: CDPSession; session: PerfSession }> {
  const client = await pageCdp(page).session();
  const session = await startSession(page, client, opts);
  return { client, session };
}

/**
 * End a span with `settle: false` and report whether lightbringer recorded
 * it. `end()` of a handle it no longer knows is a no-op, and a caller that
 * kept an owner for a span that was never recorded would shift every later
 * span onto the wrong owner.
 */
export async function endIfRecorded(
  controller: PerfSession["controller"],
  handle: SpanHandle,
): Promise<boolean> {
  const before = controller.spans.length;
  await controller.end(handle, { settle: false });
  return controller.spans.length > before;
}
