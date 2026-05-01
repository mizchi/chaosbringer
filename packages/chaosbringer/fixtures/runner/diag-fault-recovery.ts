/**
 * If we inject a 500 on a page's HTML (not just an API), does the crawler's
 * dead-link / recovery path engage? It should: status >= 500 is a recovery
 * trigger in crawler.ts.
 */

import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);

const crawler = new ChaosCrawler(
  {
    baseUrl: url,
    maxPages: 4,
    maxActionsPerPage: 1,
    headless: true,
    seed: 7,
    faultInjection: [
      {
        name: "kill-about",
        urlPattern: "/about$",
        fault: { kind: "status", status: 500, body: "<h1>500</h1>", contentType: "text/html" },
      },
    ],
  },
  {
    onPageComplete: (r) =>
      console.log(
        `${r.status.padEnd(9)} statusCode=${r.statusCode} ${r.url}  recovery=${r.recovery ? "yes" : "no"}`
      ),
  }
);

try {
  const report = await crawler.start();
  console.log("\nrecoveryCount:", report.recoveryCount);
  console.log("faultInjections:", report.faultInjections);
  console.log(
    "deadLinks:",
    report.summary.discovery?.deadLinks?.map((d) => `${d.url} (${d.statusCode})`),
  );
} finally {
  await close();
}
