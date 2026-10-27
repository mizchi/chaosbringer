/**
 * One entry of the catalog: a tiny app that mishandles bad or hostile data
 * (the `buggy` variant) and its idiomatic fix (the `fixed` variant), the data
 * chaosbringer delivers to it, and what a crawl must flag.
 *
 * The app's own server always serves good data. The bad data arrives through
 * one injection channel (an API response swapped by a fault rule, the query
 * string, tampered storage or a form fill), so the page under test is the
 * same page a real user gets and only the data differs.
 *
 * A pattern file in `src/patterns/` default-exports one of these and is picked
 * up by `registry.ts` on its own; nothing else has to be edited.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActionWeights, CrawlerOptions } from "chaosbringer";

export type Variant = "buggy" | "fixed";

/**
 * `bug-data`: data a well-meaning server or client sends that the page doesn't
 * expect (a null relation, a string where a number was). `malicious-data`:
 * data an attacker chose (markup, a script URL, a `__proto__` key).
 * `oracle`: no bug at all; the page holds the near misses the invariants must
 * stay quiet on.
 */
export type Category = "bug-data" | "malicious-data" | "oracle";

/** What the server answers on one path. Build these with `html()`, `json()`, `raw()` and `handler()`. */
export type Route =
  | { type: "html"; body: string }
  | { type: "json"; body: unknown; status?: number; delayMs?: number }
  | { type: "raw"; body: string; contentType: string; status: number }
  | { type: "handler"; handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> };

/** path (no query) → route. Both variants expose the same paths and the same good data. */
export type Routes = Record<string, Route>;

export const html = (body: string): Route => ({ type: "html", body });

export const json = (body: unknown, opts: { status?: number; delayMs?: number } = {}): Route => ({
  type: "json",
  body,
  ...opts,
});

/** `body` byte for byte, for what `json()` can't write: truncated JSON, an own `__proto__` key, HTML. */
export const raw = (body: string, contentType: string, status = 200): Route => ({
  type: "raw",
  body,
  contentType,
  status,
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

export interface RouteContext {
  /** `http://localhost:<port>` of the pattern's third-party server; empty when it has none. */
  thirdPartyOrigin: string;
}

/**
 * How the bad data reaches the page, and the benign data the control run
 * sends the same way. Each run carries one or the other, never neither, so a
 * clean control proves the signal comes from the data and not the page.
 */
export type Injection =
  | {
      /**
       * A `faults.status(200, { body })` rule answers the page's fetch/XHR to
       * `path` (with or without a query) with these bytes instead of the
       * server's. Written as is, so truncated JSON and an own `__proto__` key
       * arrive intact.
       */
      channel: "response";
      path: string;
      /**
       * Default `application/json`. One per data when they differ: a gateway's
       * HTML error page as the bad data, the API's own JSON as the benign.
       */
      contentType?: string | { bad: string; benign: string };
      bad: string;
      benign: string;
    }
  | {
      /** Appended to the entry URL (`?q=…`). A function gets the route context (the third-party origin). */
      channel: "query";
      bad: string | ((ctx: RouteContext) => string);
      benign: string | ((ctx: RouteContext) => string);
    }
  | {
      /** `faults.tamperStorage` writes `key` after the page loads; the page reads it later, on a click. */
      channel: "storage";
      /** Default `localStorage`. */
      scope?: "localStorage" | "sessionStorage";
      key: string;
      bad: string;
      benign: string;
    }
  | {
      /** `payloadDriver` fills the page's form with this one value and submits it. */
      channel: "form";
      bad: string;
      benign: string;
    }
  /** Oracle entries only: nothing is delivered. */
  | { channel: "none" };

/** What a crawl reports when the data did its damage. */
export type Signal =
  /** An error cluster (exception, unhandled rejection, console error) whose message matches. */
  | { kind: "error"; message: RegExp }
  /**
   * An invariant of the catalog suite failed (`data.prototype-pollution`, …),
   * and, with `message`, one of its failure messages matches.
   */
  | { kind: "invariant"; name: string; message?: RegExp }
  /**
   * The crawler kept the page from navigating off-site to a URL containing
   * `includes`. Only `pages[].blockedNavigations` records it: it changes no
   * exit code and no scan finding.
   */
  | { kind: "blocked-navigation"; includes: string };

export interface PatternCrawl {
  /** Path the crawl starts at (default `/`). The query channel appends to it. */
  entry?: string;
  /** Default 0: the page is judged as it loads. Set it when a click reads the data. */
  maxActionsPerPage?: number;
  /** Default 1. */
  seed?: number;
  actionWeights?: ActionWeights;
  /** Anything else `chaos()` takes; wins over the harness's own options. */
  options?: Partial<CrawlerOptions>;
}

export type PatternExpect =
  | {
      /** What the buggy variant on bad data must report. */
      signal: Signal;
      /**
       * Further signals the buggy run reports as well. The buggy run's
       * signals must be exactly `signal` plus these: anything undeclared
       * fails, so declare a side effect here rather than loosen the check.
       */
      alsoSignals?: Signal[];
    }
  /** Oracle entries: nothing may be reported. */
  | { signal: "none" };

export interface DataPattern {
  /** Must equal the file name (without `.ts`). */
  id: string;
  title: string;
  category: Category;
  /** Symptom and why it happens. */
  description: string;
  /** The fix, one line. */
  fix: string;
  /** Where data like this comes from in a real app, one line. */
  realism: string;
  /** The app's routes. `ctx.thirdPartyOrigin` is set when the pattern has `thirdPartyRoutes`. */
  routes(variant: Variant, ctx: RouteContext): Routes;
  /**
   * Routes of a second server on another registrable domain (the app is on
   * `127.0.0.1`, this one on `localhost`): the off-site page an open
   * redirect sends the user to. The page reaches it at `ctx.thirdPartyOrigin`.
   */
  thirdPartyRoutes?(variant: Variant): Routes;
  inject: Injection;
  crawl?: PatternCrawl;
  expect: PatternExpect;
}

/** Identity helper that type-checks a pattern where it is written. */
export function definePattern(pattern: DataPattern): DataPattern {
  return pattern;
}
