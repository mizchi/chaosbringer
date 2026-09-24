/**
 * SPA-aware link discovery.
 *
 * Static-HTML link extraction (`<a href>`, `<area>`, `<iframe>`,
 * `<link rel>`, `<meta refresh>`) misses every navigation that goes
 * through the History API — i.e. all React Router / Vue Router /
 * SvelteKit / TanStack Router / Next.js client-side links plus any
 * hand-rolled `useNavigate()` button.
 *
 * The runtime hook (`installSpaNavigationHook`) wraps `history.pushState`
 * and `history.replaceState` so every programmatic navigation is recorded
 * into `window.__chaosNavigations`; `drainSpaNavigations` pops them. This
 * module also exposes the pure logic that converts the recorded raw URL
 * strings into the normalised absolute-URL set the crawler then enqueues.
 */
import type { Page } from "playwright";

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

/**
 * Capture SPA route changes that go through the History API
 * (`pushState` / `replaceState`). React Router, Vue Router, SvelteKit,
 * Next.js client-side links, hand-rolled `useNavigate()` buttons — all of
 * them mutate history without firing a real navigation, which means
 * `extractLinks` (DOM-only) misses every URL they would route to. We
 * monkey-patch the two methods on every page so each call appends the URL
 * into a side channel that `drainSpaNavigations` reads later.
 */
export async function installSpaNavigationHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // @ts-ignore - custom bag attached to window
    window.__chaosNavigations = [];
    // Defined inside the init script: Playwright serialises only this
    // function's source, so the helper must travel with it.
    const wrap = (method: "pushState" | "replaceState") => {
      const orig = history[method];
      history[method] = function (...args: unknown[]) {
        try {
          const url = args[2];
          if (typeof url === "string" && url.length > 0) {
            // @ts-ignore
            window.__chaosNavigations.push({
              method,
              url,
              timestamp: Date.now(),
            });
          }
        } catch {
          /* never let our hook break the host page */
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return orig.apply(this, args as any);
      };
    };
    wrap("pushState");
    wrap("replaceState");
  });
}

/**
 * Pop and return SPA navigations recorded by the in-page hook since the
 * previous drain. Used to surface History-API routing as discovered links
 * the BFS queue can pick up.
 */
export async function drainSpaNavigations(page: Page): Promise<RawSpaNavigation[]> {
  try {
    return await page.evaluate(() => {
      // @ts-ignore - bag installed via addInitScript
      const bag = (window.__chaosNavigations || []) as RawSpaNavigation[];
      // @ts-ignore
      window.__chaosNavigations = [];
      return bag;
    });
  } catch {
    // Page may have navigated away or closed — drop and move on.
    return [];
  }
}
