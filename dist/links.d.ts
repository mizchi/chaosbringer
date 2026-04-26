/**
 * HTML link-extraction helpers.
 *
 * The browser-side extraction lives inline in `crawler.extractLinks` so it
 * can run via `page.evaluate`. This module holds the bits that are either
 * pure (serializable without a DOM) or shared with other extractors.
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
export declare function parseMetaRefreshUrl(content: string | null | undefined): string | null;
//# sourceMappingURL=links.d.ts.map