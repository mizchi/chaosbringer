/**
 * Confirm that errors fired after a chaos-action navigation record the
 * navigated URL in `error.url`, even though they end up in the originating
 * page's PageResult.
 */

import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);

const crawler = new ChaosCrawler({
  baseUrl: url,
  maxPages: 6,
  maxActionsPerPage: 1,
  headless: true,
  seed: 123,
  faultInjection: [
    { name: "api-500", urlPattern: "/api/data", fault: { kind: "status", status: 500 } },
  ],
});

try {
  const report = await crawler.start();
  for (const page of report.pages) {
    for (const err of page.errors) {
      if (err.url !== page.url) {
        console.log(`  [drifted] page=${page.url} error.url=${err.url} type=${err.type} msg=${err.message.slice(0, 60)}`);
      } else {
        console.log(`  [ok     ] page=${page.url} type=${err.type}`);
      }
    }
  }
} finally {
  await close();
}
