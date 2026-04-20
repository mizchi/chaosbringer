/**
 * Diagnostic run: log every request and who initiated it, to investigate
 * why /api/data matched twice in the earlier fault-demo run.
 *
 * `page.on("request")` is passive — it does not interfere with the route
 * handler, so we get a faithful transcript.
 */

import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);
console.log(`[fixture] ${url}`);

const crawler = new ChaosCrawler(
  {
    baseUrl: url,
    maxPages: 6,
    maxActionsPerPage: 1,
    headless: true,
    seed: 123,
    faultInjection: [
      {
        name: "api-500",
        urlPattern: "/api/data",
        fault: { kind: "status", status: 500, body: "boom" },
      },
    ],
  },
  {
    onPageStart: (u) => console.log(`\n[page-start] ${u}`),
    onPageComplete: (r) => console.log(`[page-done ] ${r.status} ${r.url} errors=${r.errors.length}`),
  }
);

// Patch newPage so every new Playwright page logs its requests.
const origStart = crawler.start.bind(crawler);
(crawler as any).start = async function () {
  const ctxPromise = (async () => {
    // Wait for context to be created by polling.
    while (!(crawler as any).context) await new Promise((r) => setTimeout(r, 10));
    const ctx = (crawler as any).context;
    ctx.on("page", (page: any) => {
      page.on("request", (req: any) => {
        const rurl = req.url();
        if (rurl.includes("/api/")) {
          const frame = req.frame();
          console.log(
            `  [req] ${req.method()} ${rurl} type=${req.resourceType()} frame=${frame.url()} isNav=${req.isNavigationRequest()}`
          );
        }
      });
    });
  })();
  const result = await origStart();
  await ctxPromise;
  return result;
};

try {
  const report = await crawler.start();
  console.log("\n[faultInjections]", report.faultInjections);
} finally {
  await close();
}
