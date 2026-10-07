import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * go.dev/learn rejects on load (`setDownloadLinks`). A click on go.dev/security
 * that went to /learn reported that rejection on /security too: console errors
 * and exceptions record the URL they fired on, but rejections were drained
 * after the actions and labelled with the page the crawl had visited.
 */
describe("an unhandled rejection after a click navigated", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/learn") {
        res.end(`<!doctype html><title>learn</title><script>Promise.reject(new Error("download links"))</script>`);
        return;
      }
      res.end(`<!doctype html><title>security</title><a href="/learn">Learn</a>`);
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it("is reported on the page it escaped on", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${server.url}/security`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      actionWeights: { scroll: 0 },
    }).start();
    expect(report.actions.some((a) => a.type === "click" && a.success)).toBe(true);
    const rejections = report.pages.flatMap((p) => p.errors).filter((e) => e.type === "unhandled-rejection");
    expect(rejections.map((e) => [e.message, e.url])).toEqual([["download links", `${server.url}/learn`]]);
  }, 60_000);
});
