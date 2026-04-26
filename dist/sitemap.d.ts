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
/**
 * True when the XML looks like a sitemap index (wraps `<sitemap>` entries
 * instead of `<url>` entries). Both forms use `<loc>`, so we inspect the
 * wrapper element to decide whether recursion is needed.
 */
export declare function isSitemapIndex(xml: string): boolean;
/**
 * Parse a single sitemap document. Returns the URLs it lists, without
 * recursing into referenced sub-sitemaps; use `fetchSitemapUrls` for that.
 */
export declare function parseSitemap(xml: string): string[];
export interface FetchSitemapOptions {
    /**
     * Override how a URL or path is read. Primarily a seam for tests — the
     * default fetches `http(s)://` URLs via `fetch` and reads everything else
     * with `fs.readFile`.
     */
    fetcher?: (source: string) => Promise<string>;
    /** Guard against cycles / runaway recursion. Default 20. */
    maxSitemaps?: number;
}
/**
 * Fetch a sitemap (or sitemap index) and return the flattened list of URLs it
 * ultimately points at. Indexes are followed breadth-first. Duplicates are
 * collapsed preserving first-seen order.
 */
export declare function fetchSitemapUrls(source: string, options?: FetchSitemapOptions): Promise<string[]>;
//# sourceMappingURL=sitemap.d.ts.map