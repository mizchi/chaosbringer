/**
 * Named bundles of noise patterns for `--exclude` / `excludePatterns`.
 *
 * Pure data plus one resolver. It lived in `crawler.ts` and was never read
 * there — only the CLI, the fixture helper and the package entry ever wanted
 * it, so the crawler was carrying a table it does not use.
 */

// Common third-party scripts to ignore in dev mode
export const COMMON_IGNORE_PATTERNS = [
  "cloudflareinsights\\.com",
  "googletagmanager\\.com",
  "google-analytics\\.com",
  "analytics\\.google\\.com",
  "facebook\\.net",
  "connect\\.facebook\\.net",
  "hotjar\\.com",
  "clarity\\.ms",
  "segment\\.io",
  "amplitude\\.com",
  // Generic error message from blocked resources
  "Failed to load resource: net::ERR_FAILED$",
];

/**
 * Named bundles of regex patterns for `--exclude` / `excludePatterns`.
 *
 * Real-world crawls hit the same families of third-party noise (analytics
 * pixels, embedded map tiles, video players) again and again. Each preset
 * names one such family so wrapper scripts can write `--ignore-preset
 * analytics,maps` instead of pasting 8 regexes. Presets compose with
 * `--exclude` — both are unioned before the pattern test runs.
 *
 * Keys are intentionally short and stable. Adding a new pattern to an
 * existing preset is backward-compatible; renaming a preset is not.
 */
export const IGNORE_PRESETS: Record<string, readonly string[]> = {
  // Analytics / tag managers / ad-conversion endpoints. Overlaps with
  // COMMON_IGNORE_PATTERNS but explicit so the preset is self-contained.
  analytics: [
    "cloudflareinsights\\.com",
    "googletagmanager\\.com",
    "google-analytics\\.com",
    "analytics\\.google\\.com",
    "googleadservices\\.com",
    "doubleclick\\.net",
    "facebook\\.net",
    "connect\\.facebook\\.net",
    "hotjar\\.com",
    "clarity\\.ms",
    "segment\\.io",
    "amplitude\\.com",
    "mixpanel\\.com",
  ],
  // Embedded map iframes + map script/tile requests.
  maps: [
    "maps\\.googleapis\\.com",
    "maps\\.google\\.com",
    "mapbox\\.com",
    "openstreetmap\\.org",
    "tile\\.openstreetmap\\.org",
  ],
  // Video / audio player embeds.
  "media-embeds": [
    "youtube\\.com/embed",
    "youtube-nocookie\\.com",
    "player\\.vimeo\\.com",
    "vimeocdn\\.com",
    "soundcloud\\.com/player",
    "spotify\\.com/embed",
  ],
  // Chrome's Opaque Response Blocking (ORB) failures for PDFs / cross-origin
  // documents — generic enough to drown out real failures otherwise.
  "pdf-orb": [
    "ERR_BLOCKED_BY_ORB",
    "net::ERR_BLOCKED_BY_ORB",
    "\\.pdf$",
  ],
  // Blocked sandboxed iframe sub-requests — common in embedded widgets.
  "iframe-sandbox": [
    "sandbox attribute",
    "Blocked a frame with origin",
    "Refused to display .* in a frame",
  ],
};

/**
 * Resolve a comma-separated preset spec into a flat list of regex
 * strings. Unknown preset names throw with the available keys listed —
 * silent fall-through would let typos drop the user's noise filter and
 * spam the report.
 */
export function resolveIgnorePresets(spec: string): string[] {
  const out: string[] = [];
  const known = Object.keys(IGNORE_PRESETS);
  for (const raw of spec.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const preset = IGNORE_PRESETS[name];
    if (!preset) {
      throw new Error(
        `unknown ignore preset "${name}". Available: ${known.join(", ")}`,
      );
    }
    out.push(...preset);
  }
  return out;
}
