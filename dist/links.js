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
export function parseMetaRefreshUrl(content) {
    if (!content)
        return null;
    // The first segment before the semicolon is the delay. Anything after is
    // parameter=value pairs, though in practice only `url=` is used.
    const semi = content.indexOf(";");
    if (semi === -1)
        return null;
    const rest = content.slice(semi + 1).trim();
    const m = rest.match(/^url\s*=\s*(.*)$/i);
    if (!m)
        return null;
    let url = m[1].trim();
    if (url.length === 0)
        return null;
    // Quoted URLs delimit with the matching quote — the URL may legitimately
    // contain `;`, so we can't just split on it. Unterminated quotes are a
    // malformed directive; return null rather than a truncated URL.
    if (url.startsWith('"') || url.startsWith("'")) {
        const quote = url[0];
        const end = url.indexOf(quote, 1);
        if (end === -1)
            return null;
        url = url.slice(1, end);
    }
    else {
        // Unquoted: terminate at the next parameter separator. Without this,
        // `0;url=/next;foo=bar` would captured as `/next;foo=bar` and queue
        // the wrong URL.
        const sep = url.indexOf(";");
        if (sep !== -1)
            url = url.slice(0, sep).trim();
    }
    return url.length > 0 ? url : null;
}
