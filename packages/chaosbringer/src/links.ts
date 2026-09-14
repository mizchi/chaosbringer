/**
 * HTML link-extraction.
 *
 * Split in two because half of it has to run in the browser. `collectRawLinks`
 * is shipped into the page by `page.evaluate` and only reads attributes;
 * everything that decides what those attributes *mean* — scheme filtering,
 * base resolution, the `<meta refresh>` grammar — runs in Node, where it is
 * reachable from a unit test instead of only from a live crawl.
 */

/**
 * Parse a `<meta http-equiv="refresh" content="...">` content attribute and
 * return the redirect URL, or null if the value doesn't carry one.
 *
 * Accepts any of these real-world shapes:
 *   "0;url=/next"
 *   "0; URL=/next"
 *   "5; url='/next'"
 *   "3;URL=https://example.com/"
 *
 * A plain `<meta http-equiv="refresh" content="5">` (delay only, no URL)
 * returns null.
 */
export function parseMetaRefreshUrl(content: string | null | undefined): string | null {
  if (!content) return null;
  // The first segment before the semicolon is the delay. Anything after is
  // parameter=value pairs, though in practice only `url=` is used.
  const semi = content.indexOf(";");
  if (semi === -1) return null;
  const rest = content.slice(semi + 1).trim();
  const m = rest.match(/^url\s*=\s*(.*)$/i);
  if (!m) return null;
  let url = m[1]!.trim();
  if (url.length === 0) return null;

  // Quoted URLs delimit with the matching quote — the URL may legitimately
  // contain `;`, so we can't just split on it. Unterminated quotes are a
  // malformed directive; return null rather than a truncated URL.
  if (url.startsWith('"') || url.startsWith("'")) {
    const quote = url[0]!;
    const end = url.indexOf(quote, 1);
    if (end === -1) return null;
    url = url.slice(1, end);
  } else {
    // Unquoted: terminate at the next parameter separator. Without this,
    // `0;url=/next;foo=bar` would captured as `/next;foo=bar` and queue
    // the wrong URL.
    const sep = url.indexOf(";");
    if (sep !== -1) url = url.slice(0, sep).trim();
  }

  return url.length > 0 ? url : null;
}

/** The raw, unparsed link material scraped from one page's DOM. */
export interface RawPageLinks {
  /**
   * Raw `href`/`src` attribute values in scrape order: `<a>`, `<area>`,
   * `<iframe>`, then `<link rel="canonical"|"alternate">`.
   */
  hrefs: string[];
  /** Raw `content` values of every `<meta http-equiv="refresh">`. */
  metaRefresh: string[];
  /** `document.baseURI` — the base the values above resolve against. */
  baseUri: string;
}

/**
 * Scrape one page's link material.
 *
 * This runs inside the browser via `page.evaluate`, so it has to stay
 * self-contained: no imports, no references to module scope. That constraint
 * is why it does no parsing at all — it hands back raw attribute values, and
 * every rule about what counts as a link lives in `resolvePageLinks`, which
 * runs in Node where it can be tested without a browser.
 */
export function collectRawLinks(): RawPageLinks {
  const hrefs: string[] = [];
  const push = (raw: string | null) => {
    if (raw !== null) hrefs.push(raw);
  };

  // <a href> — primary navigation
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    push(a.getAttribute("href"));
  }
  // <area href> — image map regions
  for (const area of Array.from(document.querySelectorAll("area[href]"))) {
    push(area.getAttribute("href"));
  }
  // <iframe src> — embedded pages
  for (const iframe of Array.from(document.querySelectorAll("iframe[src]"))) {
    push(iframe.getAttribute("src"));
  }
  // <link rel="canonical"> / rel="alternate"> — SEO-level navigation
  for (const link of Array.from(
    document.querySelectorAll(
      'link[rel~="canonical"][href], link[rel~="alternate"][href]'
    )
  )) {
    push(link.getAttribute("href"));
  }

  const metaRefresh: string[] = [];
  for (const meta of Array.from(document.querySelectorAll("meta[http-equiv]"))) {
    const httpEquiv = meta.getAttribute("http-equiv");
    if (!httpEquiv || httpEquiv.toLowerCase() !== "refresh") continue;
    const content = meta.getAttribute("content");
    if (content !== null) metaRefresh.push(content);
  }

  return { hrefs, metaRefresh, baseUri: document.baseURI };
}

/** Schemes that name an action rather than a page, so never worth queueing. */
const NON_NAVIGATING_SCHEMES = ["javascript:", "mailto:", "tel:"];

/**
 * Resolve scraped link material into absolute URLs — deduplicated, in scrape
 * order, with `<meta refresh>` targets last.
 *
 * Malformed values are dropped rather than reported: a page full of broken
 * hrefs is a page with fewer links to crawl, not a crawl failure.
 */
export function resolvePageLinks(raw: RawPageLinks): string[] {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (NON_NAVIGATING_SCHEMES.some((scheme) => lower.startsWith(scheme))) return;
    try {
      out.add(new URL(trimmed, raw.baseUri).toString());
    } catch {
      // Malformed URL — skip.
    }
  };

  for (const href of raw.hrefs) add(href);
  // Parsed here rather than in the browser so the one tested implementation of
  // the `content` grammar is the one the crawler actually runs.
  for (const content of raw.metaRefresh) add(parseMetaRefreshUrl(content));

  return Array.from(out);
}
