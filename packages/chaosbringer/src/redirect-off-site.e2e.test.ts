import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

/**
 * A same-site URL that redirects to another origin (svelte.dev/chat → a
 * Discord invite). The navigation guard lets redirect hops through, so the
 * crawler used to land on the other site and report its console errors, its
 * links and its perf as the crawled site's. It now stops at the landing page.
 */
describe("a page that redirects off-site", () => {
  let site: http.Server;
  let other: http.Server;
  let base: string;
  let otherOrigin: string;

  const listen = async (server: http.Server, host: string) => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return `http://${host}:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    // Another origin: `localhost` is not `127.0.0.1` to the browser.
    other = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>other</title><a href="/join">join</a><script>console.error("the other site's error")</script>`);
    });
    otherOrigin = await listen(other, "localhost");
    site = http.createServer((req, res) => {
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
    base = await listen(site, "127.0.0.1");
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => site.close(() => r()));
    await new Promise<void>((r) => other.close(() => r()));
  });

  it("goes back when a clicked same-site link redirects off-site, and keeps nothing of that site", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/clicky`,
      maxPages: 1,
      maxActionsPerPage: 2,
      headless: true,
      perf: true,
      // Clicks only, so the link is acted on rather than scrolled past.
      actionWeights: { click: 10, scroll: 0, hover: 0, input: 0, navigate: 0 },
    }).start();
    const left = report.actions.filter((a) => a.leftSiteTo);
    expect(left.length).toBeGreaterThan(0);
    expect(left[0]!.leftSiteTo).toBe(`${otherOrigin}/signup`);
    expect(left.every((a) => a.perf === undefined)).toBe(true);
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(1);
    expect(report.errorClusters.some((c) => c.sample.message.includes("the other site's error"))).toBe(false);
    // Each step started back on the site's page.
    expect(report.actions.length).toBe(2);
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
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(1);
    expect(report.errorClusters.some((c) => c.sample.message.includes("the other site's error"))).toBe(false);
    expect(report.pages.some((p) => p.url.startsWith(otherOrigin))).toBe(false);
    // The site's own page is still crawled and measured.
    expect(report.pages.find((p) => p.url === `${base}/`)?.perf).toBeDefined();
  }, 120_000);
});
