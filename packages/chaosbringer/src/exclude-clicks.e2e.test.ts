import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

/**
 * `excludePatterns` kept the crawl from visiting a URL as a page, but not from
 * clicking its way there. A "Log out" link was a click target like any other,
 * and Tailwind's "Plus" link (which redirects to /plus/login) left the crawl
 * acting on an excluded login page for the rest of the page's steps.
 */
describe("excluded URLs and clicks", () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/plus") {
        res.writeHead(302, { location: "/plus/login" });
        res.end();
        return;
      }
      if (req.url === "/plus/login") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>login</title><a href="/plus/login?again">sign in</a><script>console.error("login page error")</script>`);
        return;
      }
      if (req.url === "/feed.xml") {
        res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
        res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>${"<entry><title>e</title></entry>".repeat(500)}</feed>`);
        return;
      }
      if (req.url === "/feeds") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>feeds</title><a href="/feed.xml">Atom</a>`);
        return;
      }
      if (req.url === "/logout") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>bye</title>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      // A button that stays on the page, so some steps are measured here.
      res.end(`<!doctype html><title>home</title><a href="/logout">Log out</a><a href="/plus">Plus</a><button type="button">Stay</button>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("never clicks a link to an excluded URL, and goes back from one a click redirected to", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/`,
      maxPages: 1,
      maxActionsPerPage: 6,
      headless: true,
      perf: true,
      excludePatterns: ["/logout", "/login"],
      actionWeights: { click: 10, scroll: 0, hover: 0, input: 0, navigate: 0 },
    }).start();

    expect(hits).not.toContain("/logout");
    const excluded = report.actions.filter((a) => a.excludedTo);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded[0]!.excludedTo).toBe(`${base}/plus/login`);
    expect(excluded.every((a) => a.perf === undefined)).toBe(true);
    // Every measured step ran on the home page, none on the login page.
    const measured = report.actions.filter((a) => a.perf);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((a) => a.perf!.key.startsWith("/ ::"))).toBe(true);
    expect(hits).not.toContain("/plus/login?again");
    expect(report.errorClusters.some((c) => c.sample.message.includes("login page error"))).toBe(false);
  }, 120_000);

  it("stops at a page load that redirected onto an excluded URL", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/plus`,
      maxPages: 1,
      maxActionsPerPage: 2,
      headless: true,
      perf: true,
      excludePatterns: ["/login"],
    }).start();
    const plus = report.pages[0]!;
    expect(plus.excludedTo).toBe(`${base}/plus/login`);
    expect(plus.perf).toBeUndefined();
    expect(plus.errors).toEqual([]);
    expect(report.actions).toHaveLength(0);
  }, 60_000);

  it("does not measure or act on a feed the site links to", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/feeds`,
      maxPages: 2,
      maxActionsPerPage: 2,
      headless: true,
      perf: true,
      actionWeights: { click: 10, scroll: 0, hover: 0, input: 0, navigate: 0 },
    }).start();
    const feed = report.pages.find((p) => p.url.endsWith("/feed.xml"))!;
    expect(feed.contentType).toBe("application/atom+xml");
    expect(feed.perf).toBeUndefined();
    expect(feed.warnings.some((w) => w.includes("not an HTML document"))).toBe(true);
    // Clicking the feed link opened the browser's XML viewer: the crawler went
    // back, so no step ran on the viewer.
    expect(report.actions.filter((a) => a.perf?.key.startsWith("/feed.xml"))).toEqual([]);
    const opened = report.actions.filter((a) => a.openedFile);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((a) => a.openedFile === `${base}/feed.xml` && a.perf === undefined)).toBe(true);
    // The HTML page is still measured.
    expect(report.pages.find((p) => p.url.endsWith("/feeds"))?.perf).toBeDefined();
  }, 60_000);
});

describe("the browser's language", () => {
  it("is a valid BCP 47 tag even when the host locale is POSIX", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      // webscraper.io does this; `en-US@posix` makes it throw.
      res.end(`<!doctype html><title>l</title><script>new Intl.Locale(navigator.language)</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const report = await new ChaosCrawler({ baseUrl: url, maxPages: 1, maxActionsPerPage: 0, headless: true }).start();
      expect(report.pages[0]!.errors).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});
