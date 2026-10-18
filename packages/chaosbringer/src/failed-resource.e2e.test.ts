import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { formatReport } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * A missing image showed up as "Failed to load resource: the server responded
 * with a status of 404 (Not Found)" on the page, and nothing said which file:
 * the browser's message names none, and the console error kept only it and
 * the page URL. The message's location is the file.
 */
describe("a subresource that answers 404", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>home</title><img src="/missing.png" alt=""><script>console.error("app: render failed")</script>`);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it("names the file on its console error, its cluster and the text report", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${server.url}/`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
    }).start();
    const consoleErrors = report.pages.flatMap((p) => p.errors).filter((e) => e.type === "console");
    const missing = `${server.url}/missing.png`;
    // Only the browser's message gets one: a console.error's location is the
    // script that logged it, not a file that failed.
    expect(consoleErrors.map((e) => [e.message, e.resourceUrl]).sort()).toEqual([
      ["Failed to load resource: the server responded with a status of 404 (Not Found)", missing],
      ["app: render failed", undefined],
    ]);
    const cluster = report.errorClusters.find((c) => c.sample.message.startsWith("Failed to load resource"))!;
    // The message is untouched, so the cluster keeps the key a --baseline has for it.
    expect(cluster.key).toBe("console|Failed to load resource: the server responded with a status of <n> (Not Found)");
    expect(cluster.resourceUrls).toEqual([missing]);
    expect(report.errorClusters.find((c) => c.sample.message === "app: render failed")!.resourceUrls).toBeUndefined();
    const text = formatReport(report);
    expect(text.split(`resource: ${missing}`)).toHaveLength(3); // under the page, and under the cluster
  }, 60_000);
});
