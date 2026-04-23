import { describe, expect, it } from "vitest";
import { fetchSitemapUrls, isSitemapIndex, parseSitemap } from "./sitemap.js";

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://x/a</loc></url>
  <url><loc>  http://x/b  </loc></url>
  <url><loc>http://x/q?x=1&amp;y=2</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://x/sub1.xml</loc></sitemap>
  <sitemap><loc>http://x/sub2.xml</loc></sitemap>
</sitemapindex>`;

describe("parseSitemap", () => {
  it("extracts URLs from <loc> entries and trims whitespace", () => {
    expect(parseSitemap(URLSET)).toEqual(["http://x/a", "http://x/b", "http://x/q?x=1&y=2"]);
  });

  it("returns an empty list when there are no locs", () => {
    expect(parseSitemap("<urlset></urlset>")).toEqual([]);
  });
});

describe("isSitemapIndex", () => {
  it("is true for a <sitemapindex> document", () => {
    expect(isSitemapIndex(INDEX)).toBe(true);
  });

  it("is false for a plain <urlset>", () => {
    expect(isSitemapIndex(URLSET)).toBe(false);
  });
});

describe("fetchSitemapUrls", () => {
  it("returns the URLs from a plain sitemap", async () => {
    const urls = await fetchSitemapUrls("http://x/sitemap.xml", {
      fetcher: async () => URLSET,
    });
    expect(urls).toEqual(["http://x/a", "http://x/b", "http://x/q?x=1&y=2"]);
  });

  it("flattens a sitemap index, fetching each sub-sitemap once", async () => {
    const fetched: string[] = [];
    const urls = await fetchSitemapUrls("http://x/index.xml", {
      fetcher: async (src) => {
        fetched.push(src);
        if (src === "http://x/index.xml") return INDEX;
        if (src === "http://x/sub1.xml") {
          return `<urlset><url><loc>http://x/p1</loc></url></urlset>`;
        }
        return `<urlset><url><loc>http://x/p2</loc></url></urlset>`;
      },
    });
    expect(urls).toEqual(["http://x/p1", "http://x/p2"]);
    expect(fetched).toEqual(["http://x/index.xml", "http://x/sub1.xml", "http://x/sub2.xml"]);
  });

  it("deduplicates URLs that appear in multiple sub-sitemaps", async () => {
    const urls = await fetchSitemapUrls("http://x/index.xml", {
      fetcher: async (src) => {
        if (src === "http://x/index.xml") return INDEX;
        return `<urlset><url><loc>http://x/same</loc></url></urlset>`;
      },
    });
    expect(urls).toEqual(["http://x/same"]);
  });

  it("throws when expansion exceeds maxSitemaps", async () => {
    // A sitemap that references itself would cycle without this guard; we
    // simulate blow-up with a chain of 3 indexes and a limit of 2.
    const chain: Record<string, string> = {
      "http://x/i0.xml": `<sitemapindex><sitemap><loc>http://x/i1.xml</loc></sitemap></sitemapindex>`,
      "http://x/i1.xml": `<sitemapindex><sitemap><loc>http://x/i2.xml</loc></sitemap></sitemapindex>`,
      "http://x/i2.xml": `<urlset><url><loc>http://x/end</loc></url></urlset>`,
    };
    await expect(
      fetchSitemapUrls("http://x/i0.xml", {
        fetcher: async (src) => chain[src]!,
        maxSitemaps: 2,
      })
    ).rejects.toThrow(/maxSitemaps=2/);
  });
});
