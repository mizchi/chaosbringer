import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { exitReasons } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { Invariant } from "./types.js";

/**
 * A renderer crash (an out-of-memory tab, a browser bug the page hits) was
 * reported as whatever Playwright call met the dead page next: a timeout
 * with a `page.waitForTimeout: Page crashed` exception, or an error page with
 * a `Target crashed` one. The `crash` type existed and nothing emitted it.
 */
describe("a page whose renderer crashes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/") {
        res.end(`<!doctype html><title>home</title><a href="/about">about</a> <a href="/other">other</a>`);
        return;
      }
      res.end(`<!doctype html><title>${req.url}</title><p>${req.url}</p>`);
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  /** Crashes the renderer of /about once it has loaded, through CDP's `Page.crash`. */
  const crashAbout: Invariant = {
    name: "crash-about",
    when: "afterLoad",
    urlPattern: /\/about$/,
    check: async ({ page }) => {
      const cdp = await page.context().newCDPSession(page);
      const crashed = page.waitForEvent("crash", { timeout: 10_000 });
      // The command gets no answer from a renderer that is gone.
      void cdp.send("Page.crash").catch(() => {});
      await crashed;
      return true;
    },
  };

  // With actions, the pause between two met the dead page first and failed
  // as `page.waitForTimeout: Page crashed`: a timeout and a JS exception.
  // Without any, nothing did, and the page read as a clean success.
  it.each([0, 2])("records it as a crash on a failed page, not a timeout or a JS exception, and the crawl goes on (%i actions)", async (actions) => {
    const report = await new ChaosCrawler({
      baseUrl: `${server.url}/`,
      maxPages: 3,
      maxActionsPerPage: actions,
      seed: 1,
      headless: true,
      invariants: [crashAbout],
    }).start();
    const about = report.pages.find((p) => p.url.endsWith("/about"))!;
    expect(about.status).toBe("error");
    expect(about.errors.map((e) => [e.type, e.message, e.url])).toEqual([["crash", "renderer crashed", `${server.url}/about`]]);
    // Actions can reach /other first.
    expect(report.pages.map((p) => [new URL(p.url).pathname, p.status]).sort()).toEqual([
      ["/", "success"],
      ["/about", "error"],
      ["/other", "success"],
    ]);
    expect(report.summary).toMatchObject({ crashes: 1, jsExceptions: 0, timeoutPages: 0, errorPages: 1 });
    expect(report.errorClusters.map((c) => c.key)).toEqual(["crash|renderer crashed"]);
    expect(exitReasons(report)).toEqual([`1 renderer crash (first: ${server.url}/about)`]);
  }, 60_000);
});
