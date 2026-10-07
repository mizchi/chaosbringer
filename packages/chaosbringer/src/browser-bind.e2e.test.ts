import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BoundBrowser, attachHint } from "./browser-bind.js";
import { ChaosCrawler } from "./crawler.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

describe("bind", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>Bound</title><h1>Watched</h1><button>Go</button>`);
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it("serves the crawl's browser to another client while it runs", async () => {
    let bound: BoundBrowser | undefined;
    let contexts = 0;
    let attaching: Promise<void> | undefined;
    const report = await new ChaosCrawler(
      { baseUrl: `${server.url}/`, maxPages: 1, maxActionsPerPage: 2, headless: true, bind: "crawl-test" },
      {
        onBind: (b) => {
          bound = b;
        },
        onPageStart: () => {
          // What `npx playwright cli attach crawl-test` does, mid-crawl.
          attaching = (async () => {
            const other = await chromium.connect(bound!.endpoint);
            // The crawl's context, made before its first page.
            contexts = other.contexts().length;
            await other.close();
          })();
        },
      },
    ).start();
    await attaching;
    expect(report.pages).toHaveLength(1);
    expect(bound?.title).toBe("crawl-test");
    expect(contexts).toBeGreaterThan(0);
    expect(attachHint(bound!)).toContain("npx playwright cli attach crawl-test");
  }, 60_000);
});
