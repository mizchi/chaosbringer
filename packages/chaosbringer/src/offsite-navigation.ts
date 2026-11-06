/**
 * Off-site navigations: what started each one, whether its target came from
 * the page's own URL, and `invariants.noOffsiteRedirect()`.
 *
 * The crawler keeps every crawl on its own origin: a navigation to another
 * one is blocked before it leaves the browser, and a redirect hop is let
 * through (the guard decides on the URL a navigation started for), so the
 * crawl stops at the other site's page. That used to be recorded as a bare
 * URL in `blockedNavigations`, which no exit rule, report line or scan
 * finding read: a `/go?next=https://evil.example/` that sent the browser to
 * whatever `next` said passed `--strict`, `--data-safety` and `scan`.
 *
 * What started the navigation is what tells an open redirect from a link:
 * a user who clicks "Visit our partner" asked to leave; a page that leaves
 * on its own (a script, a meta refresh, a 3xx) took the user somewhere,
 * and when that place is written in its own address, whoever wrote the link
 * chose it.
 */
import { compileUrlMatcher } from "./url-matcher.js";
import type { Invariant, OffsiteNavigation, OffsiteNavigationTrigger, PageResult, UrlMatcher } from "./types.js";

/** The triggers that are the page leaving on its own, not the user or an iframe. */
const REDIRECT_TRIGGERS: ReadonlySet<OffsiteNavigationTrigger> = new Set(["script", "meta-refresh", "server-redirect"]);

/** Whether `nav` is a redirect the page made on its own: a script, a meta refresh or a 3xx. */
export function isOffsiteRedirect(nav: Pick<OffsiteNavigation, "trigger">): boolean {
  return REDIRECT_TRIGGERS.has(nav.trigger);
}

/** The redirects of `pages`, in page order (`isOffsiteRedirect`). */
export function offsiteRedirects(pages: ReadonlyArray<Pick<PageResult, "offsiteNavigations">>): OffsiteNavigation[] {
  return pages.flatMap((p) => (p.offsiteNavigations ?? []).filter(isOffsiteRedirect));
}

/**
 * What started a navigation the crawler blocked. `reason` is the browser's
 * (CDP `Page.frameRequestedNavigation`'s `ClientNavigationReason`), absent
 * when it gave none.
 */
export function blockedTrigger(info: { mainFrame: boolean; stepRunning: boolean; reason?: string }): OffsiteNavigationTrigger {
  if (!info.mainFrame) return "frame";
  if (info.stepRunning) return "click";
  if (info.reason === "metaTagRefresh" || info.reason === "httpHeaderRefresh") return "meta-refresh";
  return "script";
}

/** `decodeURIComponent`, or the text as it is when it does not decode. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Where `to`'s host appears in `from`'s query or fragment, as written or
 * URL-decoded (twice: a value encoded again on its way through a link).
 * The host is matched as a whole token, so `?next=//evil.example`,
 * `?next=https%3A%2F%2Fevil.example%2F`, `?u=/\evil.example` and
 * `#return=evil.example/x` all count, and `evil.example.com` does not count
 * for `evil.example`.
 */
export function reflectedIn(from: string, to: string): OffsiteNavigation["reflected"] {
  let source: URL;
  let target: URL;
  try {
    source = new URL(from);
    target = new URL(to);
  } catch {
    return undefined;
  }
  if (!target.host) return undefined;
  const host = target.host.toLowerCase();
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`);
  const holds = (raw: string) => {
    const once = decoded(raw);
    return [raw, once, decoded(once)].some((s) => token.test(s.toLowerCase().replace(/\\/g, "/")));
  };
  for (const [param, value] of source.searchParams) {
    if (holds(value)) return { in: "query", param };
  }
  const fragment = source.hash.slice(1);
  if (fragment && holds(fragment)) return { in: "fragment" };
  return undefined;
}

/** One `OffsiteNavigation`, with `reflected` worked out from the two URLs. */
export function offsiteNavigation(
  from: string,
  to: string,
  trigger: OffsiteNavigationTrigger,
  extra: { failed?: string } = {},
): OffsiteNavigation {
  const reflected = trigger === "frame" ? undefined : reflectedIn(from, to);
  return { from, to, trigger, ...(reflected ? { reflected } : {}), ...(extra.failed ? { failed: extra.failed } : {}) };
}

const TRIGGER_LABELS: Record<OffsiteNavigationTrigger, string> = {
  click: "click",
  script: "script redirect",
  "meta-refresh": "meta refresh",
  "server-redirect": "server redirect",
  frame: "iframe",
};

/** `the "next" query parameter` / `the fragment`. */
function reflectedLabel(reflected: NonNullable<OffsiteNavigation["reflected"]>): string {
  return reflected.in === "query" ? `the ${JSON.stringify(reflected.param)} query parameter` : "the fragment";
}

/**
 * `<from> -> <to> (<trigger>; target from <where>; failed: <error>)`, as the
 * text report lists a page's off-site navigations.
 */
export function describeOffsiteNavigation(nav: OffsiteNavigation): string {
  const notes = [
    TRIGGER_LABELS[nav.trigger] ?? nav.trigger,
    ...(nav.reflected ? [`target from ${reflectedLabel(nav.reflected)}`] : []),
    ...(nav.failed ? [`failed: ${nav.failed}`] : []),
  ];
  return `${nav.from} -> ${nav.to} (${notes.join("; ")})`;
}

/**
 * `open redirect: <from> -> <to> (script redirect, to the URL in its "next"
 * query parameter)`, or `off-site redirect: <from> -> <to> (server
 * redirect)` for a target its address does not carry.
 */
function violation(nav: OffsiteNavigation): string {
  const how = TRIGGER_LABELS[nav.trigger] ?? nav.trigger;
  const failed = nav.failed ? `; it failed to load: ${nav.failed}` : "";
  if (nav.reflected) {
    const where = nav.reflected.in === "query" ? `its ${JSON.stringify(nav.reflected.param)} query parameter` : "its fragment";
    return `open redirect: ${nav.from} -> ${nav.to} (${how}, to the URL in ${where}${failed})`;
  }
  return `off-site redirect: ${nav.from} -> ${nav.to} (${how}${failed})`;
}

/** Most redirects one violation lists; the rest are counted. */
const MAX_LISTED = 3;

export interface NoOffsiteRedirectOptions {
  /** Display name for reporting. Default: `navigation.no-offsite-redirect`. */
  name?: string;
  /** Restrict to pages whose URL matches this matcher. */
  urlPattern?: Invariant["urlPattern"];
  /**
   * Where a redirect may go: an origin (`"https://login.example.com"`, no
   * path) allows every URL on it, a RegExp the URLs it matches. For an SSO
   * provider, a payment page, a CDN the site sends downloads to. Default:
   * none.
   */
  allow?: ReadonlyArray<string | RegExp>;
}

/** The origin `s` names when it is an origin and nothing more (a trailing `/` is fine), else undefined. */
function bareOrigin(s: string): string | undefined {
  try {
    const u = new URL(s);
    if (u.origin === "null" || u.pathname !== "/" || u.search !== "" || u.hash !== "" || u.username !== "") return undefined;
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?$/i.test(s.trim())) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * `allow` as a test of a target URL. Throws on a string that is not a bare
 * origin: `https://sso.example.com/login` would read as "that page only" to
 * one reader and "that site" to another.
 */
export function compileOffsiteAllow(allow: ReadonlyArray<string | RegExp> = []): (url: string) => boolean {
  const origins = new Set<string>();
  const patterns: RegExp[] = [];
  for (const entry of allow) {
    if (entry instanceof RegExp) {
      patterns.push(compileUrlMatcher(entry as UrlMatcher));
      continue;
    }
    const origin = typeof entry === "string" ? bareOrigin(entry) : undefined;
    if (origin === undefined) {
      throw new Error(
        `chaosbringer: noOffsiteRedirect allow entry ${JSON.stringify(entry)} is not an origin ` +
          '(like "https://login.example.com", no path) or a RegExp',
      );
    }
    origins.add(origin);
  }
  return (url) => {
    let origin: string | undefined;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = undefined;
    }
    return (origin !== undefined && origins.has(origin)) || patterns.some((p) => p.test(url));
  };
}

/**
 * Fails a page that redirected off-site on its own: by a script, a meta
 * refresh or a server redirect (`OffsiteNavigation.trigger`), to an origin
 * `allow` does not list. A click the user made is not a redirect, nor is an
 * iframe. The message says `open redirect` when the target was in the
 * page's own URL, and names the parameter.
 *
 * Runs `afterVisit`: a page that redirected is one the crawler stops at,
 * where the other phases never run. It reads what the crawl recorded, not
 * the DOM, so it costs nothing per page.
 */
export function noOffsiteRedirect(options: NoOffsiteRedirectOptions = {}): Invariant {
  const allowed = compileOffsiteAllow(options.allow);
  return {
    name: options.name ?? "navigation.no-offsite-redirect",
    urlPattern: options.urlPattern,
    when: "afterVisit",
    check({ offsiteNavigations }) {
      const hits = (offsiteNavigations ?? []).filter((n) => isOffsiteRedirect(n) && !allowed(n.to));
      if (hits.length === 0) return true;
      const shown = hits.slice(0, MAX_LISTED).map(violation);
      const more = hits.length - shown.length;
      return `${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
    },
  };
}
