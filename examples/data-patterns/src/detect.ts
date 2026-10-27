/**
 * One case: serve one variant of a pattern, deliver one kind of data, and
 * crawl the entry page once with the catalog suite and `strict` on.
 *
 * One crawl per case is enough because nothing in it is random: one page, a
 * fixed seed, no actions unless the entry asks for them, and the data comes
 * from a rule that fires on every matching request. Each crawl launches its
 * own browser, so a polluted prototype or a stored value can't leak into the
 * next case.
 */

import { chaos, getExitCode, type Invariant } from "chaosbringer";
import { type CaseData, toCrawlOptions } from "./inject.js";
import type { DataPattern, Variant } from "./pattern.js";
import { servePattern } from "./server.js";
import { catalogSuite, counted } from "./suite.js";
import { type CaseRun, deliveredOf, signalsOf } from "./verdict.js";

export async function runCase(pattern: DataPattern, variant: Variant, data: CaseData): Promise<CaseRun> {
  const server = await servePattern(pattern, variant);
  const suite = counted(catalogSuite());
  // The page's visible text after the actions, so a fix can be held to
  // rendering its fallback and not just to being clean. Never fails the run.
  const captured = { text: "" };
  const captureText: Invariant = {
    name: "capture.body-text",
    when: "afterActions",
    check: async ({ page }) => {
      try {
        captured.text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
      } catch {
        // A blocked or closed page has nothing to read; leave the text empty.
      }
    },
  };
  const c = pattern.crawl ?? {};
  try {
    const injected = toCrawlOptions(pattern, data, server.ctx);
    const entryUrl = server.origin + (c.entry ?? "/") + injected.query;
    const { report, exitCode } = await chaos({
      baseUrl: entryUrl,
      maxPages: 1,
      maxActionsPerPage: c.maxActionsPerPage ?? 0,
      seed: c.seed ?? 1,
      settle: "adaptive",
      perf: false,
      headless: true,
      strict: true,
      logLevel: "error",
      invariants: [...suite.invariants, captureText],
      ...(c.actionWeights ? { actionWeights: c.actionWeights } : {}),
      ...injected.options,
      ...c.options,
    });
    return {
      variant,
      data,
      entryUrl,
      report,
      exitCode,
      defaultExit: getExitCode(report, false),
      signals: signalsOf(report),
      delivered: deliveredOf(pattern, report, entryUrl),
      bodyText: captured.text,
      invariantRuns: suite.runs(),
    };
  } finally {
    await server.close();
  }
}
