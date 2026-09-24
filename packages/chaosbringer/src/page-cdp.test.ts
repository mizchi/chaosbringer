import type { BrowserContext, CDPSession, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { pageCdp } from "./page-cdp.js";

/** A context whose `newCDPSession` records every attach and every send. */
function fakeContext(opts: { failAttach?: number; failSend?: Set<string> } = {}) {
  const attaches: Page[] = [];
  const sends: string[] = [];
  let failuresLeft = opts.failAttach ?? 0;
  const context = {
    async newCDPSession(page: Page): Promise<CDPSession> {
      attaches.push(page);
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("Target closed");
      }
      return {
        async send(method: string) {
          sends.push(method);
          if (opts.failSend?.has(method)) {
            opts.failSend.delete(method);
            throw new Error(`${method} failed`);
          }
          return {};
        },
      } as unknown as CDPSession;
    },
  } as unknown as BrowserContext;
  return { context, attaches, sends };
}

const fakePage = () => ({}) as Page;

describe("pageCdp", () => {
  it("returns the same PageCdp for the same page and a new one per page", () => {
    const { context } = fakeContext();
    const a = fakePage();
    const b = fakePage();
    expect(pageCdp(context, a)).toBe(pageCdp(context, a));
    expect(pageCdp(context, a)).not.toBe(pageCdp(context, b));
  });

  it("attaches lazily, once per page, however many callers ask", async () => {
    const { context, attaches } = fakeContext();
    const page = fakePage();
    const cdp = pageCdp(context, page);
    expect(attaches).toHaveLength(0);
    const [s1, s2] = await Promise.all([cdp.session(), pageCdp(context, page).session()]);
    expect(s1).toBe(s2);
    expect(await cdp.session()).toBe(s1);
    expect(attaches).toEqual([page]);
  });

  it("enables each domain once, including concurrent callers", async () => {
    const { context, sends } = fakeContext();
    const cdp = pageCdp(context, fakePage());
    await Promise.all([cdp.enable("Network"), cdp.enable("Network"), cdp.enable("Performance")]);
    await cdp.enable("Network");
    expect(sends.sort()).toEqual(["Network.enable", "Performance.enable"]);
  });

  it("retries an attach that failed instead of caching the rejection", async () => {
    const { context, attaches } = fakeContext({ failAttach: 1 });
    const cdp = pageCdp(context, fakePage());
    await expect(cdp.session()).rejects.toThrow("Target closed");
    await expect(cdp.session()).resolves.toBeDefined();
    expect(attaches).toHaveLength(2);
  });

  it("retries a domain enable that failed", async () => {
    const { context, sends } = fakeContext({ failSend: new Set(["Network.enable"]) });
    const cdp = pageCdp(context, fakePage());
    await expect(cdp.enable("Network")).rejects.toThrow("Network.enable failed");
    await cdp.enable("Network");
    await cdp.enable("Network");
    expect(sends).toEqual(["Network.enable", "Network.enable"]);
  });
});
