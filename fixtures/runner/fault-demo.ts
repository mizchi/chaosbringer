/**
 * Dogfood run that demonstrates fault injection + an invariant that
 * depends on the API succeeding.
 */

import { ChaosCrawler } from "../../src/crawler.js";
import type { Invariant } from "../../src/types.js";
import { printReport } from "../../src/reporter.js";
import { startFixtureServer } from "../site/server.js";

const { url, close } = await startFixtureServer(0);
console.log(`[fixture] ${url}`);

const invariants: Invariant[] = [
  {
    name: "api-consumer-renders-ok",
    urlPattern: "/api-consumer$",
    when: "afterLoad",
    check: async ({ page }) => {
      const status = (await page.locator("#status").textContent())?.trim() ?? "";
      return status === "ok" || `status text was "${status}"`;
    },
  },
];

const crawler = new ChaosCrawler(
  {
    baseUrl: url,
    maxPages: 6,
    maxActionsPerPage: 1,
    headless: true,
    seed: 123,
    invariants,
    faultInjection: [
      {
        name: "api-500",
        urlPattern: "/api/data$",
        fault: { kind: "status", status: 500, body: "boom" },
        probability: 1,
      },
    ],
  },
  {
    onPageComplete: (r) => console.log(`  ${r.status.padEnd(9)} ${r.url} [${r.errors.length} errors]`),
  }
);

try {
  const report = await crawler.start();
  console.log("");
  printReport(report, false);
  console.log(`\nExit code would be: ${report.summary.invariantViolations > 0 ? 1 : 0}`);
} finally {
  await close();
}
