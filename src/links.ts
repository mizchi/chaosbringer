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
export function parseMetaRefreshUrl(content: string | null | undefined): string | null {
  if (!content) return null;
  // The first segment before the semicolon is the delay. Anything after is
  // parameter=value pairs, though in practice only `url=` is used.
  const semi = content.indexOf(";");
  if (semi === -1) return null;
  const rest = content.slice(semi + 1).trim();
  // Case-insensitive `url=`
  const m = rest.match(/^url\s*=\s*(.*)$/i);
  if (!m) return null;
  let url = m[1]!.trim();
  if (url.length === 0) return null;
  // Strip surrounding single/double quotes.
  if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1);
  }
  return url.length > 0 ? url : null;
}
