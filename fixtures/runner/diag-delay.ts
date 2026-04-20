/**
 * Sanity-check the "delay" fault kind: inject 500ms latency on /api/data
 * and confirm the /api-consumer page still resolves the fetch (i.e. the
 * request continues, it's just slow).
 */

import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);

const t0 = Date.now();
const crawler = new ChaosCrawler({
  baseUrl: `${url}/api-consumer`,
  maxPages: 1,
  maxActionsPerPage: 0,
  headless: true,
  seed: 1,
  faultInjection: [
    { name: "slow-api", urlPattern: "/api/data", fault: { kind: "delay", ms: 500 } },
  ],
});
const report = await crawler.start();
const elapsed = Date.now() - t0;
console.log("pages:", report.pages.map((p) => `${p.url} status=${p.status}`));
console.log("faultInjections:", report.faultInjections);
console.log("elapsed:", elapsed, "ms (should be >= 500 due to delay)");
await close();
