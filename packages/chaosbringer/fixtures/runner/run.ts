/**
 * Dogfood runner: boot the fixture server, run ChaosCrawler against it,
 * print the report, exit.
 *
 *   pnpm tsx fixtures/runner/run.ts [--seed <n>]
 */

import { parseArgs } from "node:util";
import { ChaosCrawler } from "../../src/crawler.js";
import { printReport } from "../../src/reporter.js";
import { startFixtureServer } from "../site/server.js";

const { values } = parseArgs({
  options: {
    seed: { type: "string" },
    "max-pages": { type: "string" },
    "max-actions": { type: "string" },
    "no-headless": { type: "boolean", default: false },
  },
});

const seed = values.seed !== undefined ? Number(values.seed) : undefined;

const { url, close } = await startFixtureServer(0);
console.log(`[fixture] listening on ${url}`);

const crawler = new ChaosCrawler(
  {
    baseUrl: url,
    maxPages: values["max-pages"] ? Number(values["max-pages"]) : 20,
    maxActionsPerPage: values["max-actions"] ? Number(values["max-actions"]) : 5,
    headless: !values["no-headless"],
    seed,
  },
  {
    onPageComplete: (result) => {
      const errs = result.errors.length > 0 ? ` [${result.errors.length} errors]` : "";
      console.log(`  ${result.status.padEnd(9)} ${result.url}${errs}`);
    },
    onBlockedNavigation: (target) => {
      console.log(`  blocked   → ${target}`);
    },
  }
);

try {
  const report = await crawler.start();
  console.log("");
  printReport(report, false);
} finally {
  await close();
}
