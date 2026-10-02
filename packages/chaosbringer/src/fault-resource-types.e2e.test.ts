import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { faults } from "./faults.js";
import { scanFaultRule } from "./scan/run.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * One URL that is both a page and its data (`/` and `/?_rsc=1`, as Next.js
 * App Router does it). A rule limited to fetch / XHR fails the data request
 * and leaves the page's own navigation alone; without the limit the page
 * itself fails to load.
 */
describe("resourceTypes in a crawl", () => {
  let server: TestServer;
  let base: string;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if ((req.url ?? "").includes("_rsc")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("data");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><p id="out">…</p><script>
        fetch("/?_rsc=1").then((r) => r.text()).then((t) => (out.textContent = t), () => (out.textContent = "failed"));
      </script>`);
    });
    base = server.url;
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  const crawl = (rule: ReturnType<typeof faults.abort>) =>
    new ChaosCrawler({ baseUrl: `${base}/`, maxPages: 1, maxActionsPerPage: 0, headless: true, faultInjection: [rule] }).start();
  const pattern = () => `^${base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/(?:[?#].*)?$`;

  it("fails the data request and loads the page when limited to fetch / XHR", async () => {
    const report = await crawl(scanFaultRule("abort", pattern(), 1000));
    expect(report.pages[0]!.status).toBe("success");
    expect(report.faultInjections?.[0]?.injected).toBe(1);
  }, 60_000);

  it("fails the page itself without the limit", async () => {
    const report = await crawl(faults.abort({ urlPattern: pattern() }));
    expect(report.pages[0]!.status).toBe("error");
  }, 60_000);
});
