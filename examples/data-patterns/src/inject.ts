/**
 * How each injection channel becomes crawl options: the one place that knows
 * which chaosbringer feature delivers which kind of data.
 *
 *   response → a `faults.status(200, { body })` rule on the path's fetch/XHR
 *   query    → a suffix on the entry URL
 *   storage  → a `faults.tamperStorage` lifecycle fault after load
 *   form     → `payloadDriver` with a one-value list
 *
 * Each rule is named `data:<path>` / `data:<key>`, so the report's fault
 * stats say whether the data was delivered.
 */

import { type CrawlerOptions, faults, payloadDriver } from "chaosbringer";
import type { DataPattern, RouteContext, Routes, Variant } from "./pattern.js";
import { raw } from "./pattern.js";

/** Which data a run carries: the entry's bad data, its benign data, or (oracle entries) none. */
export type CaseData = "bad" | "benign" | "none";

export interface InjectedCrawl {
  /** Appended to the entry URL; empty unless the channel is `query`. */
  query: string;
  options: Pick<CrawlerOptions, "faultInjection" | "lifecycleFaults" | "driver">;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches `path` on any origin, with or without a query, and nothing longer:
 * `/api/user` and `/api/user?x=1`, not `/api/users`.
 */
export function pathPattern(path: string): RegExp {
  return new RegExp(`^[a-z]+://[^/]+${escapeRegExp(path)}(?:\\?|$)`);
}

export function toCrawlOptions(pattern: DataPattern, data: CaseData, ctx: RouteContext): InjectedCrawl {
  const inject = pattern.inject;
  if (data === "none" || inject.channel === "none") {
    if (data !== "none" || inject.channel !== "none") {
      throw new Error(`${pattern.id}: data "${data}" on channel "${inject.channel}"; only an oracle entry runs without data`);
    }
    return { query: "", options: {} };
  }
  switch (inject.channel) {
    case "response":
      return {
        query: "",
        options: {
          faultInjection: [
            faults.status(200, {
              urlPattern: pathPattern(inject.path),
              resourceTypes: ["fetch", "xhr"],
              body: inject[data],
              contentType: inject.contentType ?? "application/json",
              name: `data:${inject.path}`,
            }),
          ],
        },
      };
    case "query": {
      const value = inject[data];
      return { query: typeof value === "function" ? value(ctx) : value, options: {} };
    }
    case "storage":
      return {
        query: "",
        options: {
          lifecycleFaults: [
            faults.tamperStorage({
              scope: inject.scope ?? "localStorage",
              key: inject.key,
              value: inject[data],
              when: "afterLoad",
              name: `data:${inject.key}`,
            }),
          ],
        },
      };
    case "form":
      return { query: "", options: { driver: payloadDriver({ payloads: [inject[data]] }) } };
  }
}

/** The channel and where it delivers, for the README tables: `response \`/api/user\``. */
export function describeInjection(pattern: DataPattern): string {
  const inject = pattern.inject;
  switch (inject.channel) {
    case "response":
      return `response \`${inject.path}\``;
    case "query":
      return `query on \`${pattern.crawl?.entry ?? "/"}\``;
    case "storage":
      return `${inject.scope ?? "localStorage"} \`${inject.key}\``;
    case "form":
      return "form";
    case "none":
      return "–";
  }
}

/**
 * The variant's routes with a response entry's bad data served by the app
 * itself, for `chaosbringer scan`, which takes no fault rules. Other channels
 * are unchanged: scan reaches them through its URL and crawler options.
 */
export function toServedRoutes(pattern: DataPattern, variant: Variant, ctx: RouteContext): Routes {
  const routes = pattern.routes(variant, ctx);
  const inject = pattern.inject;
  if (inject.channel !== "response") return routes;
  return { ...routes, [inject.path]: raw(inject.bad, inject.contentType ?? "application/json") };
}
