/**
 * Record network traffic from the fixture site to a HAR file, then replay
 * it back with the fixture server SHUT DOWN. If replay works without the
 * server, HAR capture + routing is correct.
 */

import { unlinkSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const harPath = join(tmpdir(), `chaosbringer-demo-${Date.now()}.har`);

// --- Record --------------------------------------------------------------
const live = await startFixtureServer(0);
console.log(`[record] fixture at ${live.url}, capturing to ${harPath}`);

const recordCrawler = new ChaosCrawler({
  baseUrl: live.url,
  maxPages: 4,
  maxActionsPerPage: 0,
  headless: true,
  seed: 1,
  har: { path: harPath, mode: "record" },
});
const recordReport = await recordCrawler.start();
console.log(`[record] pages=${recordReport.pagesVisited} visited=${recordReport.pages.map((p) => p.url).join(", ")}`);
await live.close();

const harSize = statSync(harPath).size;
const har = JSON.parse(readFileSync(harPath, "utf-8"));
console.log(`[record] HAR file size=${harSize} entries=${har.log.entries.length}`);
console.log(`[record] HAR URLs:`);
for (const entry of har.log.entries as Array<{ request: { url: string; method: string }; response: { status: number } }>) {
  console.log(`    ${entry.request.method} ${entry.request.url} -> ${entry.response.status}`);
}

// --- Replay against the captured HAR, with the fixture server gone -------
console.log(`\n[replay] fallback mode (missing URLs go to network — will fail since server is down)`);
const replayCrawler = new ChaosCrawler({
  baseUrl: recordReport.baseUrl,
  maxPages: 4,
  maxActionsPerPage: 0,
  headless: true,
  seed: 1,
  har: { path: harPath, mode: "replay", notFound: "fallback" },
});
const replayReport = await replayCrawler.start();
console.log(`[replay] pages=${replayReport.pagesVisited} visited=${replayReport.pages.map((p) => `${p.url}[${p.status}]`).join(", ")}`);

if (existsSync(harPath)) unlinkSync(harPath);
