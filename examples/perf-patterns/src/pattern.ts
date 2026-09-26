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

export interface PatternExpect {
  /** perfKey glob (`*` = anything) the problem must be measured on, e.g. `"/ :: click *"`. */
  key: string;
  /**
   * Dot path into a span (`"cpu.blockingMs"`, `"render.layoutCount"`,
   * `"network.requestCount"`, `"network.settledMs"`) or, starting with
   * `degradation.`, into the crawl's degradation entries for matching keys
   * (`"degradation.delta.effectiveMs"`, `"degradation.faulted.requestCount"`).
   * A bare `effectiveMs` is `max(durationMs, network.settledMs)` per span.
   */
  metric: string;
  direction: "lower";
  /**
   * The fix must beat the slow variant by all given bounds:
   * `ratio`: slow >= ratio × fixed; `absolute`: slow − fixed >= absolute.
   */
  minImprovement: { ratio?: number; absolute?: number };
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
  routes(variant: Variant): Routes;
  crawl: PatternCrawl;
  expect: PatternExpect;
}

/** Identity helper that type-checks a pattern where it is written. */
export function definePattern(pattern: Pattern): Pattern {
  return pattern;
}
