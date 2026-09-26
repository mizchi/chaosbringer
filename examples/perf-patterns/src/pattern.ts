/**
 * One entry of the catalog: a tiny page with a known performance anti-pattern
 * (the `slow` variant) and its idiomatic fix (the `fixed` variant), plus what
 * a crawl with `perf` on must find on it.
 *
 * A pattern file in `src/patterns/` default-exports one of these and is picked
 * up by `registry.ts` on its own; nothing else has to be edited.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActionWeights, CrawlerOptions, FaultRule, PerfOptions, SettleMode } from "chaosbringer";

export type Variant = "slow" | "fixed";

export type Category = "render" | "network" | "main-thread" | "memory" | "chaos";

/** What the server answers on one path. Build these with `html()`, `json()` and `handler()`. */
export type Route =
  | { type: "html"; body: string }
  | { type: "json"; body: unknown; status?: number; delayMs?: number }
  | { type: "handler"; handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> };

/** path (no query) → route. Both variants should expose the same paths, so their perfKeys match. */
export type Routes = Record<string, Route>;

export const html = (body: string): Route => ({ type: "html", body });

export const json = (body: unknown, opts: { status?: number; delayMs?: number } = {}): Route => ({
  type: "json",
  body,
  ...opts,
});

export const handler = (handle: Extract<Route, { type: "handler" }>["handle"]): Route => ({
  type: "handler",
  handle,
});

/** A whole HTML document around `body`, with the viewport meta and no favicon request. */
export function page(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${title}</title>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

export interface PatternCrawl {
  /** Path the crawl starts at (default `/`). */
  entry?: string;
  maxPages: number;
  maxActionsPerPage: number;
  seed: number;
  /** Default `"adaptive"`: spans then follow the app's work, not the networkidle wait. */
  settle?: SettleMode;
  /** Default `true` (light level). */
  perf?: boolean | PerfOptions;
  /** Network faults (`faults.status/delay/hang/...`), applied to both variants. */
  faults?: FaultRule[];
  actionWeights?: ActionWeights;
  /** A chaosbringer driver (`weightedRandomDriver()`, ...). */
  driver?: unknown;
  /** Anything else `chaos()` takes; wins over the fields above. */
  options?: Partial<CrawlerOptions>;
}

/** One metric the fix must improve, and by how much. */
export interface MetricExpect {
  /**
   * Dot path into a span (`"cpu.blockingMs"`, `"render.layoutCount"`,
   * `"network.requestCount"`, `"network.settledMs"`); or, starting with
   * `degradation.`, into the crawl's degradation entries for matching keys
   * (`"degradation.delta.effectiveMs"`, `"degradation.faulted.requestCount"`);
   * or, starting with `page.`, into `PageResult.perfPage` of the pages whose
   * load span's key matches (`"page.vitals.CLS.value"`, `"page.vitals.FCP.value"`,
   * `"page.media.oversizedCount"`, `"page.renderBlocking.scripts"`,
   * `"page.network.thirdParty.encodedKB"`): one value per page visit, so the
   * key must be a load key (`"/ :: load"`).
   * A bare `effectiveMs` is `max(durationMs, network.settledMs)` per span.
   */
  metric: string;
  direction: "lower";
  /**
   * The fix must beat the slow variant by all given bounds:
   * `ratio`: slow >= ratio × fixed; `absolute`: slow − fixed >= absolute.
   */
  minImprovement: { ratio?: number; absolute?: number };
  /**
   * `page.` metrics only: the value of a measured page that lacks the field.
   * perfPage leaves a part out rather than write 0 (`network.thirdParty` when
   * there was no third-party request, `renderBlocking` when nothing blocked),
   * so a fix that removes the thing entirely needs `absentAs: 0` to be read
   * as 0. Leave it unset for a field that is a measured 0 when present.
   */
  absentAs?: number;
}

export interface PatternExpect extends MetricExpect {
  /** perfKey glob (`*` = anything) the problem must be measured on, e.g. `"/ :: click *"`. */
  key: string;
  /** More metrics on the same key the fix must also improve (reported, and asserted, beside the main one). */
  alsoExpect?: MetricExpect[];
}

export interface RouteContext {
  /** `http://localhost:<port>` of the pattern's third-party server; empty when it has none. */
  thirdPartyOrigin: string;
}

export interface Pattern {
  /** Must equal the file name (without `.ts`). */
  id: string;
  title: string;
  category: Category;
  /** Symptom and why it happens. */
  description: string;
  /** The fix, one line. */
  fix: string;
  /** The app's routes. `ctx.thirdPartyOrigin` is set when the pattern has `thirdPartyRoutes`. */
  routes(variant: Variant, ctx: RouteContext): Routes;
  /**
   * Routes of a second server on another registrable domain (the app is on
   * `127.0.0.1`, this one on `localhost`), for scripts, widgets and tags a
   * real page loads from other companies' hosts. The page reaches it at
   * `ctx.thirdPartyOrigin`; perfPage counts its traffic as `network.thirdParty`.
   */
  thirdPartyRoutes?(variant: Variant): Routes;
  crawl: PatternCrawl;
  expect: PatternExpect;
}

/** Identity helper that type-checks a pattern where it is written. */
export function definePattern(pattern: Pattern): Pattern {
  return pattern;
}
