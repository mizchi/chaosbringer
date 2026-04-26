/**
 * Sitemap URL extraction. Seeds the crawler with every URL in a site's
 * sitemap.xml (or sitemap index), so a chaos run is comprehensive even on
 * sites that bury pages behind JS-rendered nav where link discovery misses
 * them.
 *
 * Parsing is regex-based on purpose: sitemap.xml is a narrow format, has no
 * attributes we care about, and we avoid an XML dependency. Entries are
 * decoded for the five XML predefined entities only — enough for the URLs
 * that real sitemaps actually produce.
 */
import { readFile } from "node:fs/promises";
const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
function decodeXmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
function extractLocs(xml) {
    const out = [];
    let match;
    LOC_RE.lastIndex = 0;
    while ((match = LOC_RE.exec(xml)) !== null) {
        const raw = match[1].trim();
        if (raw.length === 0)
            continue;
        out.push(decodeXmlEntities(raw));
    }
    return out;
}
/**
 * True when the XML looks like a sitemap index (wraps `<sitemap>` entries
 * instead of `<url>` entries). Both forms use `<loc>`, so we inspect the
 * wrapper element to decide whether recursion is needed.
 */
export function isSitemapIndex(xml) {
    return /<sitemapindex[\s>]/i.test(xml);
}
/**
 * Parse a single sitemap document. Returns the URLs it lists, without
 * recursing into referenced sub-sitemaps; use `fetchSitemapUrls` for that.
 */
export function parseSitemap(xml) {
    return extractLocs(xml);
}
async function defaultFetcher(source) {
    if (/^https?:\/\//i.test(source)) {
        const res = await fetch(source);
        if (!res.ok) {
            throw new Error(`sitemap fetch ${source} failed: HTTP ${res.status}`);
        }
        return await res.text();
    }
    return await readFile(source, "utf-8");
}
/**
 * Fetch a sitemap (or sitemap index) and return the flattened list of URLs it
 * ultimately points at. Indexes are followed breadth-first. Duplicates are
 * collapsed preserving first-seen order.
 */
export async function fetchSitemapUrls(source, options = {}) {
    const fetcher = options.fetcher ?? defaultFetcher;
    const maxSitemaps = options.maxSitemaps ?? 20;
    const queue = [source];
    const seenSitemaps = new Set();
    const urls = [];
    const seenUrls = new Set();
    let processed = 0;
    while (queue.length > 0) {
        if (processed >= maxSitemaps) {
            throw new Error(`sitemap expansion exceeded maxSitemaps=${maxSitemaps} — suspected cycle or too many sub-sitemaps`);
        }
        const current = queue.shift();
        if (seenSitemaps.has(current))
            continue;
        seenSitemaps.add(current);
        processed++;
        const xml = await fetcher(current);
        const locs = extractLocs(xml);
        if (isSitemapIndex(xml)) {
            for (const loc of locs)
                queue.push(loc);
        }
        else {
            for (const loc of locs) {
                if (seenUrls.has(loc))
                    continue;
                seenUrls.add(loc);
                urls.push(loc);
            }
        }
    }
    return urls;
}
