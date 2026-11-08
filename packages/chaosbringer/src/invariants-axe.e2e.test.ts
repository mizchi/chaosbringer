import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { axe } from "./invariants.js";
import type { CrawlerOptions, PageResult } from "./types.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * `invariants.axe()` / `--axe` on a site with a strict Content-Security-Policy
 * and iframes. axe used to go in through `page.addScriptTag`, an inline
 * <script> that `script-src 'self'` refuses, so every page failed with an
 * injection error unrelated to accessibility; and it ran in the top document
 * only, so a violation inside an iframe was never reported.
 */
describe("invariants.axe() on a CSP page with iframes", () => {
  let server: TestServer;
  let base: string;
  let cross: string;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      const html = (body: string, csp = true) => {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          ...(csp ? { "content-security-policy": "script-src 'self'" } : {}),
        });
        res.end(`<!doctype html><html lang="en"><title>t</title><main><h1>t</h1>${body}</main></html>`);
      };
      // No alt: `image-alt`. A data: URL, so there is no 404 to report.
      const img = `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
      if (path === "/") {
        return html(
          `${img}<iframe title="same" src="/embed"></iframe><iframe title="cross" src="${cross}/embed"></iframe>`
        );
      }
      // No accessible name: `button-name`.
      if (path === "/embed") return html(`<button></button><iframe title="nested" src="/nested"></iframe>`);
      if (path === "/nested") return html(img);
      if (path === "/plain") return html(img, false);
      // A frame sandboxed without `allow-scripts` runs no timers, so axe can't
      // finish there; `allow-scripts` alone (an opaque origin) still can.
      if (path === "/sandboxed") {
        return html(
          `${img}<iframe title="none" sandbox src="/embed"></iframe>` +
            `<iframe title="same-origin" sandbox="allow-same-origin" src="/embed"></iframe>` +
            `<iframe title="scripts" sandbox="allow-scripts" src="/nested"></iframe>`
        );
      }
      if (path === "/stuck") return html(`${img}<iframe title="stuck" src="${cross}/spin"></iframe>`);
      // Its main thread spins from just after load, as a stuck widget's does.
      if (path === "/spin") {
        return html(`<p>spin</p><script>addEventListener("load", () => setTimeout(() => { for (;;) {} }))</script>`, false);
      }
      res.writeHead(404);
      res.end();
    });
    base = server.url;
    // `localhost` is another origin than `127.0.0.1`.
    cross = `http://localhost:${server.port}`;
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  async function crawl(path: string, options: Partial<CrawlerOptions> = {}): Promise<PageResult> {
    const report = await new ChaosCrawler({
      baseUrl: `${base}${path}`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      logLevel: "error",
      // The guard fails every cross-origin document request, iframes included.
      blockExternalNavigation: false,
      invariants: [axe()],
      ...options,
    }).start();
    return report.pages[0]!;
  }

  async function axeMessages(path: string, options: Partial<CrawlerOptions> = {}): Promise<string[]> {
    return (await crawl(path, options)).errors.filter((e) => e.type === "invariant-violation").map((e) => e.message);
  }

  it.each([
    ["in-process iframes", {}],
    ["out-of-process iframes (--site-per-process)", { launchOptions: { args: ["--site-per-process"] } }],
  ])("scans the top document and every iframe, naming the frame: %s", async (_, options) => {
    expect(await axeMessages("/", options)).toEqual([
      "[a11y-axe] 5 a11y violations: image-alt(×1, critical)" +
        `; in frame ${base}/embed: button-name(×1, critical)` +
        `; in frame ${cross}/embed: button-name(×1, critical)` +
        `; in frame ${base}/nested: image-alt(×1, critical)` +
        `; in frame ${cross}/nested: image-alt(×1, critical)`,
    ]);
  }, 60_000);

  it("keeps the top-document message as it was", async () => {
    expect(await axeMessages("/plain")).toEqual(["[a11y-axe] 1 a11y violations: image-alt(×1, critical)"]);
  }, 60_000);

  it("reports nothing for a cross-origin iframe the crawl blocked (the default)", async () => {
    expect(await axeMessages("/", { blockExternalNavigation: true })).toEqual([
      "[a11y-axe] 3 a11y violations: image-alt(×1, critical)" +
        `; in frame ${base}/embed: button-name(×1, critical)` +
        `; in frame ${base}/nested: image-alt(×1, critical)`,
    ]);
  }, 60_000);

  it("leaves an excluded iframe out", async () => {
    expect(await axeMessages("/", { invariants: [axe({ exclude: ["iframe"] })] })).toEqual([
      "[a11y-axe] 1 a11y violations: image-alt(×1, critical)",
    ]);
  }, 60_000);

  it("leaves an iframe sandboxed without allow-scripts untested, adding no console errors", async () => {
    // Scanning such a frame, axe never finished: the check stalled about 30s
    // a frame, and each timer axe set there logged a "Blocked script
    // execution" console error, recorded as a page error. The crawl logs a
    // few of those for such a frame on its own, in the order frames load.
    const consoleErrors = (page: PageResult) =>
      page.errors
        .filter((e) => e.type === "console")
        .map((e) => e.message)
        .sort();
    const withoutAxe = await crawl("/sandboxed", { invariants: [] });
    const page = await crawl("/sandboxed");
    expect(consoleErrors(page)).toEqual(consoleErrors(withoutAxe));
    expect(page.errors.filter((e) => e.type === "invariant-violation").map((e) => e.message)).toEqual([
      `[a11y-axe] 2 a11y violations: image-alt(×1, critical); in frame ${base}/nested: image-alt(×1, critical)`,
    ]);
  }, 60_000);

  it("leaves an out-of-process iframe whose main thread is stuck untested", async () => {
    expect(await axeMessages("/stuck", { launchOptions: { args: ["--site-per-process"] } })).toEqual([
      "[a11y-axe] 1 a11y violations: image-alt(×1, critical)",
    ]);
  }, 60_000);

  it("falls back to the top document's axe.run without runPartial (axe-core before 4.3)", async () => {
    // Pins `window.axe` to a stub that has only `run`: the injected source's
    // `window.axe = axe` lands on the no-op setter.
    const stub = `Object.defineProperty(window, "axe", {
      get: () => ({ run: async () => ({ violations: [{ id: "stub-rule", impact: "minor", nodes: [{}] }] }) }),
      set: () => {},
    });`;
    expect(await axeMessages("/", { initScripts: [stub] })).toEqual(["[a11y-axe] 1 a11y violations: stub-rule(×1, minor)"]);
  }, 60_000);
});
