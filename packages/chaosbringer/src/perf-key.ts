/**
 * Pure helpers for per-step performance measurement: the stable span key, span
 * names and the budget-rule glob. Kept apart from `perf.ts` — which drives a
 * browser — so every rule that decides what a key looks like is unit-testable
 * without launching one. The `perf` option helpers live in `perf-options.ts`
 * and the report trimming in `perf-trim.ts`.
 */

import { escapeRegExp, normalizeUrl } from "./filters.js";
import type { ActionResult, ActionTarget } from "./types.js";

/**
 * What separates the route from the kind in a perfKey. The route side never
 * contains it: `urlPattern` of an absolute URL is a parsed pathname, which
 * percent-encodes spaces, and the crawler only keys the absolute URLs it
 * visited. So a key splits at its first separator, even when the kind (a
 * selector) contains one.
 */
export const PERF_KEY_SEPARATOR = " :: ";

/**
 * Collapse one path segment that is an identifier rather than a route name.
 * Three shapes cover the ids real apps put in URLs: database row numbers,
 * UUIDs, and long hex digests (Mongo ObjectIds, content hashes). A shorter
 * hex segment is left alone because short words like `cafe` or `add` are
 * valid hex too, and collapsing those would merge routes that differ.
 */
function collapseSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return ":id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
  if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
  return segment;
}

/**
 * The route a URL belongs to, for grouping measurements across runs.
 *
 * Only the pathname survives. The origin is dropped because a baseline taken
 * against `localhost:3000` has to match a PR run against `localhost:41873`;
 * the query and hash are dropped because they carry state (filters, cache
 * busters, tokens) rather than identify a screen. Path segments that are ids
 * become `:id`, so `/items/17` and `/items/42` are one route with one budget.
 * The URL goes through the crawler's own `normalizeUrl` first, so trailing
 * slashes group exactly the way the visited set does.
 */
export function urlPattern(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(normalizeUrl(url)).pathname;
  } catch {
    // Not an absolute URL. Strip what would have been the query and hash by
    // hand rather than put them in a key that is supposed to be stable.
    pathname = url.split(/[?#]/, 1)[0] || "/";
  }
  return pathname.split("/").map(collapseSegment).join("/") || "/";
}

/**
 * What an action did, for its key and span name: `<type> <selector ?? target>`.
 *
 * A scroll has no selector and its target is the random offset it scrolled to
 * (`scrollY: 523`), which would give every scroll its own key; it is keyed as
 * plain `scroll`. The fill value an `input` wrote, and the option a `select`
 * chose, never appear here: neither `selector` nor `target` carries them.
 */
export function actionKind(action: Pick<ActionResult, "type" | "selector" | "target">): string {
  if (action.type === "scroll" && !action.selector) return "scroll";
  const what = action.selector ?? action.target;
  return what ? `${action.type} ${what}` : action.type;
}

/**
 * The `ActionResult.type` an action on a target of this type is recorded
 * with — fixed before it is attempted, whether it then works or throws.
 * The crawler records with it and `candidatePerfKey` predicts with it, so a
 * candidate's key is the key its action's span will carry.
 */
export function attemptedActionType(
  targetType: ActionTarget["type"],
  operation?: "clear",
): ActionResult["type"] {
  if (targetType === "scroll") return "scroll";
  if (targetType === "select") return "select";
  if (targetType === "input") return operation === "clear" ? "clear" : "input";
  return "click";
}

/**
 * The URL an action's perfKey is built from: the page's live URL when the
 * action began, so a step after a click that navigated (a full navigation or
 * an SPA route change) is keyed by the screen it ran on. Keying every step by
 * the visit URL put the new screen's controls under the old route, where
 * neither a candidate predicted from the live route nor a later visit of the
 * new route (whose steps carry its own route) could ever match them.
 *
 * The visit URL is kept when the live URL is not on the visit's origin: an
 * error page (`chrome-error://…`), `about:blank`, or an external page an
 * unblocked link reached. Those have no route of the app to key by.
 */
export function actionRouteUrl(visitUrl: string, liveUrl: string | undefined): string {
  if (!liveUrl || liveUrl === visitUrl) return visitUrl;
  try {
    const visit = new URL(visitUrl);
    const live = new URL(liveUrl);
    if (live.origin === visit.origin && (live.protocol === "http:" || live.protocol === "https:")) {
      return liveUrl;
    }
  } catch {
    // Not absolute: keep the visit's route.
  }
  return visitUrl;
}

/**
 * The perfKey the span of acting on this candidate will carry. Pass the
 * driver step (`{ url, currentUrl }`): the key is built from the route the
 * page is on (`actionRouteUrl`), which is what the crawler keys the span by.
 * A string is used as that route URL as it is — `step.url` alone is only
 * right until an action navigates. The default operation only: a `clear`
 * pick keys differently. A scroll's selector is dropped, as `actionKind`
 * drops it from the result.
 */
export function candidatePerfKey(
  at: string | { url: string; currentUrl?: string },
  candidate: { type: ActionTarget["type"]; selector: string },
): string {
  const url = typeof at === "string" ? at : actionRouteUrl(at.url, at.currentUrl);
  const type = attemptedActionType(candidate.type);
  return perfKey(url, actionKind(type === "scroll" ? { type } : { type, selector: candidate.selector }));
}

/** The span key budgets and baselines join on: `<urlPattern> :: <kind>`. */
export function perfKey(url: string, kind: string): string {
  return `${urlPattern(url)}${PERF_KEY_SEPARATOR}${kind}`;
}

/** The `<urlPattern>` part of a perfKey. */
export function perfKeyRoute(key: string): string {
  return key.split(PERF_KEY_SEPARATOR, 1)[0];
}

/** Span name for a page load: `load <path>`, the real path rather than the pattern. */
export function loadSpanName(url: string): string {
  try {
    return `load ${new URL(url).pathname}`;
  } catch {
    return `load ${url}`;
  }
}

/**
 * File name stem for a page's sidecar report: the run's id, then the page's
 * index, then its route pattern, with everything outside `[A-Za-z0-9_-]`
 * squashed. The index keeps two visits to one route in one run apart and
 * sorts a run's files in crawl order; the run id keeps two runs apart, since
 * every crawler numbers its pages from 0 and the Playwright fixture builds
 * one crawler per test into the same `outDir`.
 */
export function perfSlug(url: string, pageIndex: number, runId: string): string {
  const route = urlPattern(url)
    .replace(/:id/g, "id")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${runId}-${String(pageIndex).padStart(3, "0")}-${route || "root"}`;
}

/**
 * Compile a `perfBudgets` `match` glob into an anchored RegExp. `*` is the
 * only wildcard and matches any run of characters (spaces and `/` included,
 * since a key is `<path> :: <type> <selector>` and a glob has to be able to
 * span all three); everything else — `.`, `[`, `(`, `?` in selectors — is
 * literal. There is no `**`/`?`/brace syntax on purpose: a key is not a file
 * path, and every extra metacharacter is one a CSS selector can contain.
 */
export function compilePerfKeyGlob(match: string): RegExp {
  const body = match
    .split("*")
    .map(escapeRegExp)
    .join(".*");
  // `s`: `*` must span line terminators too. escapeSelector folds `\n` but a
  // selector or target from script-set text can still carry `\r`, U+2028 or
  // U+2029, and without dotAll that span would silently escape every rule,
  // `"*"` included.
  return new RegExp(`^${body}$`, "s");
}

/**
 * The predicate a `perfBudgets` rule applies to a perfKey: a literal
 * comparison for `exact` rules (emit-budgets keys), the glob otherwise.
 */
export function perfRuleMatcher(rule: { match: string; exact?: boolean }): (key: string) => boolean {
  if (rule.exact) return (key) => key === rule.match;
  const re = compilePerfKeyGlob(rule.match);
  return (key) => re.test(key);
}
