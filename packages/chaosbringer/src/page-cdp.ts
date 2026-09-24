/**
 * One shared CDP session per page.
 *
 * The network profile, V8 coverage, lifecycle faults and (later) the perf
 * layer each need CDP on the same page. Each of them used to attach its own
 * session, which costs a round-trip per attach and, worse, lets two users
 * each call `Network.enable` so every network event is delivered twice. This
 * module hands all of them the same session and enables each domain once.
 *
 * Sessions are not closed here: a page-scoped CDP session is detached by the
 * browser when its page closes, and the WeakMap entry goes with the page.
 */

import type { BrowserContext, CDPSession, Page } from "playwright";

/**
 * CDP domains more than one crawler layer enables on the same page. Tracing is
 * not here although the perf layer uses it: CDP's Tracing domain has no
 * `enable`, it is started and ended per trace.
 */
export type PageCdpDomain = "Network" | "Performance" | "Profiler";

export interface PageCdp {
  /** Lazily opened on first use, then the same session for the page's lifetime. */
  session(): Promise<CDPSession>;
  /**
   * Enable a domain on the shared session. Idempotent per domain, so callers
   * never double-enable and double the event traffic. A failed enable is not
   * remembered, so a later caller retries it.
   */
  enable(domain: PageCdpDomain): Promise<void>;
}

const byPage = new WeakMap<Page, PageCdp>();

/** The shared {@link PageCdp} for `page`, created on first call. */
export function pageCdp(context: BrowserContext, page: Page): PageCdp {
  const existing = byPage.get(page);
  if (existing) return existing;

  let session: Promise<CDPSession> | null = null;
  const enabled = new Map<PageCdpDomain, Promise<void>>();

  const cdp: PageCdp = {
    session() {
      if (session === null) {
        session = context.newCDPSession(page);
        // Forget a failed attach, so the next caller can try again instead of
        // inheriting a rejection for the rest of the page's life.
        session.catch(() => {
          session = null;
        });
      }
      return session;
    },
    enable(domain) {
      let pending = enabled.get(domain);
      if (!pending) {
        pending = cdp.session().then(async (client) => {
          await client.send(`${domain}.enable`);
        });
        enabled.set(domain, pending);
        pending.catch(() => {
          enabled.delete(domain);
        });
      }
      return pending;
    },
  };
  byPage.set(page, cdp);
  return cdp;
}
