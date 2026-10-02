import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * A same-site URL that redirects to another origin (svelte.dev/chat → a
 * Discord invite). The navigation guard lets redirect hops through, so the
 * crawler used to land on the other site and report its console errors, its
 * links and its perf as the crawled site's. It now stops at the landing page.
 */
describe("a page that redirects off-site", () => {
  let site: TestServer;
  let other: TestServer;
  let base: string;
  let otherOrigin: string;

  beforeAll(async () => {
    // Another origin: `localhost` is not `127.0.0.1` to the browser.
    other = await startTestServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>other</title><a href="/join">join</a><script>console.error("the other site's error")</script>`);
      },
      { host: "localhost" },
    );
    otherOrigin = other.url;
    site = await startTestServer((req, res) => {
      if (req.url === "/join") {
        res.writeHead(302, { location: `${otherOrigin}/signup` });
        res.end();
        return;
      }
      if (req.url === "/clicky") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>clicky</title><a href="/join">Create account</a>`);
        return;
      }
      if (req.url === "/chat") {
        res.writeHead(302, { location: `${otherOrigin}/invite` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>site</title><a href="/chat">chat</a>`);
    });
    base = site.url;
  }, 30_000);

  afterAll(async () => {
    await site.close();
    await other.close();
  });

  it("goes back when a clicked same-site link redirects off-site, and keeps nothing of that site", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/clicky`,
      maxPages: 1,
      maxActionsPerPage: 2,
      headless: true,
      perf: true,
      // No scroll target: the link is the only thing to act on.
      actionWeights: { scroll: 0 },
    }).start();
    const left = report.actions.filter((a) => a.leftSiteTo);
    expect(left.length).toBeGreaterThan(0);
    expect(left[0]!.leftSiteTo).toBe(`${otherOrigin}/signup`);
    expect(left.every((a) => a.perf === undefined)).toBe(true);
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(1);
    expect(report.pages[0]!.blockedNavigations).toContain(`${otherOrigin}/signup`);
    expect(report.errorClusters.some((c) => c.sample.message.includes("the other site's error"))).toBe(false);
    // /clicky has one link: the second step clicking it too proves it ran
    // back on /clicky, not on the other site's page.
    expect(left).toHaveLength(2);
    expect(left.every((a) => a.leftSiteTo === `${otherOrigin}/signup`)).toBe(true);
  }, 120_000);

  it("records the redirect, and crawls, measures and reports nothing of the other site", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/`,
      maxPages: 3,
      maxActionsPerPage: 0,
      headless: true,
      perf: true,
    }).start();

    const chat = report.pages.find((p) => p.url === `${base}/chat`)!;
    expect(chat.redirectedTo).toBe(`${otherOrigin}/invite`);
    expect(chat.errors).toEqual([]);
    expect(chat.links).toEqual([]);
    expect(chat.perf).toBeUndefined();
    expect(chat.warnings.some((w) => w.includes("redirected off-site"))).toBe(true);
    expect(chat.blockedNavigations).toEqual([`${otherOrigin}/invite`]);
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(1);
    expect(report.errorClusters.some((c) => c.sample.message.includes("the other site's error"))).toBe(false);
    expect(report.pages.some((p) => p.url.startsWith(otherOrigin))).toBe(false);
    // The site's own page is still crawled and measured.
    expect(report.pages.find((p) => p.url === `${base}/`)?.perf).toBeDefined();
  }, 120_000);
});
