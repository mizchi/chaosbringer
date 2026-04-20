/**
 * Count what kinds of chaos actions happen on each page, seeded.
 * If interactive pages produce >70% scrolls we're wasting budget.
 */

import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);

const seeds = [1, 2, 3, 4, 5];
for (const seed of seeds) {
  const crawler = new ChaosCrawler({
    baseUrl: url,
    maxPages: 3,
    maxActionsPerPage: 10,
    headless: true,
    seed,
  });
  const report = await crawler.start();
  const byType = new Map<string, number>();
  for (const a of report.actions) {
    byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
  }
  const total = report.actions.length;
  const entries = [...byType.entries()].map(([t, n]) => `${t}=${n} (${Math.round((n / total) * 100)}%)`);
  console.log(`seed=${seed}  total=${total}  ${entries.join(", ")}`);
}

await close();
