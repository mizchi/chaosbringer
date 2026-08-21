import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { watchUnhandledRejections } from "./rejections.js";

/**
 * "The spinner stopped" and "the spinner stopped and nothing escaped" are
 * different findings, and the second is usually the bug — so this is half of
 * any error-path oracle. Three readers writing their own harness needed it and
 * had to reconstruct it from a comment in `dist/`.
 */
describe("watchUnhandledRejections", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><title>r</title><body><script>
        window.escapeOne = (msg) => { Promise.reject(new Error(msg)); };
        window.throwOne = (msg) => { setTimeout(() => { throw new Error(msg); }, 0); };
        window.handled = () => { Promise.reject(new Error("caught")).catch(() => {}); };
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

  /**
   * `drain()` empties as it reads, so polling it directly is a trap: a poll for
   * "length is 0" passes on the first tick, before anything was captured. Read
   * once into a variable instead, after giving the microtask a turn.
   */
  const drainOnce = async (page: import("playwright").Page, watcher: { drain(): Promise<Array<{ message: string }>> }) => {
    await page.evaluate("new Promise((r) => setTimeout(r, 50))");
    return watcher.drain();
  };

  it("captures an escaped rejection, and empties on read", async () => {
    const page = await browser.newPage();
    try {
      const watcher = await watchUnhandledRejections(page);
      await page.goto(base + "/");
      await page.evaluate('window.escapeOne("boom")');
      const first = await drainOnce(page, watcher);
      expect(first.map((r) => r.message)).toEqual(["boom"]);
      // Reading empties it, so the same escape is not reported twice — which is
      // what you want when you probe at a deadline and again after a
      // quiescence window.
      expect(await watcher.drain()).toEqual([]);
      // And a second escape still lands.
      await page.evaluate('window.escapeOne("second")');
      expect((await drainOnce(page, watcher)).map((r) => r.message)).toEqual(["second"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("does not let the same rejection arrive again as a pageerror", async () => {
    // Without `preventDefault()` Chromium reports it twice — once here and once
    // through `pageerror` — so a harness watching both counts one escape as two
    // and calls a rejection a thrown exception.
    const page = await browser.newPage();
    try {
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));
      const watcher = await watchUnhandledRejections(page);
      await page.goto(base + "/");
      await page.evaluate('window.escapeOne("claimed")');
      expect((await drainOnce(page, watcher)).map((r) => r.message)).toEqual(["claimed"]);
      await new Promise((r) => setTimeout(r, 150));
      expect(pageErrors).toEqual([]);

      // …and a real throw still reaches `pageerror`, so the guard above is not
      // satisfied by swallowing everything.
      await page.evaluate('window.throwOne("thrown")');
      await expect.poll(() => pageErrors.length).toBe(1);
      expect(pageErrors[0]).toContain("thrown");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("ignores a rejection the app handled", async () => {
    const page = await browser.newPage();
    try {
      const watcher = await watchUnhandledRejections(page);
      await page.goto(base + "/");
      await page.evaluate("window.handled()");
      await new Promise((r) => setTimeout(r, 150));
      expect(await watcher.drain()).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("survives navigation, so one call covers a whole test", async () => {
    const page = await browser.newPage();
    try {
      const watcher = await watchUnhandledRejections(page);
      await page.goto(base + "/");
      await page.goto(base + "/?second");
      await page.evaluate('window.escapeOne("after-nav")');
      expect((await drainOnce(page, watcher)).map((r) => r.message)).toEqual(["after-nav"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports nothing, rather than throwing, once the page is gone", async () => {
    const page = await browser.newPage();
    const watcher = await watchUnhandledRejections(page);
    await page.goto(base + "/");
    await page.close();
    await expect(watcher.drain()).resolves.toEqual([]);
  }, 60_000);
});
