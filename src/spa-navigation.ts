/**
 * SPA-aware link discovery.
 *
 * Static-HTML link extraction (`<a href>`, `<area>`, `<iframe>`,
 * `<link rel>`, `<meta refresh>`) misses every navigation that goes
 * through the History API — i.e. all React Router / Vue Router /
 * SvelteKit / TanStack Router / Next.js client-side links plus any
 * hand-rolled `useNavigate()` button.
 *
 * The runtime hook in `crawler.ts` wraps `history.pushState` and
 * `history.replaceState` so every programmatic navigation is recorded
 * into `window.__chaosNavigations`. This module exposes the pure logic
 * that converts the recorded raw URL strings into the normalised
 * absolute-URL set the crawler then enqueues.
 */
const SKIP_SCHEMES = ["javascript:", "mailto:", "tel:", "data:", "blob:"];

/** Shape of one entry in `window.__chaosNavigations`. */
export interface RawSpaNavigation {
  /** `pushState` or `replaceState` — both are History API mutations. */
  method: "pushState" | "replaceState";
  /** The raw URL argument passed to the History method. May be relative. */
  url: string;
  /** When it fired (ms since epoch); kept for diagnostics, not used here. */
  timestamp: number;
}

/**
 * Take the raw entries the in-page hook captured and produce a
 * deduplicated absolute-URL set, dropping unsupported schemes and
 * malformed URLs (same conventions as `extractLinks`).
 *
 * `baseUrl` is the document's base URL the crawler should resolve
 * relative paths against — pass `page.url()` at the moment of drain.
 */
export function resolveSpaNavigationUrls(
  entries: ReadonlyArray<RawSpaNavigation>,
  baseUrl: string,
): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const raw = (entry.url ?? "").trim();
    if (raw.length === 0) continue;
    if (SKIP_SCHEMES.some((s) => raw.startsWith(s))) continue;
    try {
      const absolute = new URL(raw, baseUrl).toString();
      out.add(absolute);
    } catch {
      // Malformed — drop.
    }
  }
  return [...out];
}
