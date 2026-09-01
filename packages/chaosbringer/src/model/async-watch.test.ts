import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAsyncWatchScript, drainScheduledWork, readPendingAsync } from "./runner.js";

/**
 * The timer watch is what lets a run say "no rejection escaped" rather than
 * "none had escaped yet". Two things about it are only true in a browser, and
 * both were wrong at some point:
 *
 *   - it has to be installed *before* the page's own scripts, or every timer
 *     scheduled during load is invisible — and an action-less plan has no
 *     other timers;
 *   - a read with no instrumentation in place has to be distinguishable from a
 *     read of an idle page, because the first is not a measurement.
 *
 * The unit tests for `nextDrainWaitMs` cover the arithmetic on a
 * `PendingAsync`; nothing but a real page covers where that value comes from.
 */
describe("the async watch, in a page", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      // Both timers are scheduled during load, which is the case an `afterLoad`
      // install could never see.
      res.end(`<!doctype html><title>t</title><body><script>
        setTimeout(() => { window.__ranLate = true; }, 400);
        setTimeout(() => { window.__ranSoon = true; }, 40);
      </script></body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reports an uninstrumented page as unmeasured, not as idle", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(base + "/");
      const pending = await readPendingAsync(page);
      // The counters read the same as an idle page. `measured` is the only
      // thing that separates them, and everything the drain claims rests on it.
      expect(pending.timers).toBe(0);
      expect(pending.measured).toBe(false);
    } finally {
      await page.close();
    }
  });

  it("sees timers the page scheduled while loading", async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: buildAsyncWatchScript() });
      await page.goto(base + "/");
      const pending = await readPendingAsync(page);
      expect(pending.measured).toBe(true);
      // The 400ms one is certainly still pending; the 40ms one may already have
      // run, so assert the floor rather than an exact count that races the load.
      expect(pending.timers).toBeGreaterThanOrEqual(1);
      expect(pending.dueInMs?.length).toBe(pending.timers);
    } finally {
      await page.close();
    }
  });

  it("drains them, and the page's own callbacks actually ran", async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript({ content: buildAsyncWatchScript() });
      await page.goto(base + "/");
      const after = await drainScheduledWork(page, 3000);
      expect(after.measured).toBe(true);
      expect(after.timers).toBe(0);
      // Waiting for a timer to become *due* is not the same as waiting for it
      // to run — the drain's `+25ms` is what makes the difference, and a
      // pending count of zero would be satisfied either way.
      expect(await page.evaluate("window.__ranLate === true")).toBe(true);
      expect(await page.evaluate("window.__ranSoon === true")).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("survives a repeated install and still behaves like setTimeout", async () => {
    const page = await browser.newPage();
    try {
      // Playwright re-runs init scripts on every navigation, so the script
      // guards against installing twice. That guard is deliberately *not*
      // asserted here: what it prevents is a wrapper wrapping a wrapper, and
      // from inside the page that is indistinguishable from a single install —
      // the reader only ever sees the outermost state bag, and the counts come
      // out the same either way. Asserting it would mean writing a test that
      // passes whether or not the guard is there, which is worse than not
      // having one. What is checked is the part that *is* observable: a page
      // that got the script twice still gets working timers.
      await page.addInitScript({ content: buildAsyncWatchScript() });
      await page.addInitScript({ content: buildAsyncWatchScript() });
      await page.goto(base + "/");
      expect((await readPendingAsync(page)).measured).toBe(true);
      // The patched `setTimeout` still has to behave like `setTimeout`,
      // including `clearTimeout` removing the entry rather than leaking it.
      const cleared = await page.evaluate(`(() => {
        const id = setTimeout(() => { window.__shouldNotRun = true; }, 50);
        clearTimeout(id);
        return true;
      })()`);
      expect(cleared).toBe(true);
      await drainScheduledWork(page, 2000);
      expect(await page.evaluate("window.__shouldNotRun === true")).toBe(false);
    } finally {
      await page.close();
    }
  });
});
