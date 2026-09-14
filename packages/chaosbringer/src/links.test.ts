import { describe, expect, it } from "vitest";
import {
  parseMetaRefreshUrl,
  resolvePageLinks,
  type RawPageLinks,
} from "./links.js";

describe("parseMetaRefreshUrl", () => {
  it("parses a basic delay;url= value", () => {
    expect(parseMetaRefreshUrl("0;url=/next")).toBe("/next");
  });

  it("tolerates whitespace around the directive", () => {
    expect(parseMetaRefreshUrl("0; url=/next")).toBe("/next");
    expect(parseMetaRefreshUrl("5 ;   url   =   /deep   ")).toBe("/deep");
  });

  it("is case-insensitive on the URL keyword", () => {
    expect(parseMetaRefreshUrl("0;URL=/next")).toBe("/next");
    expect(parseMetaRefreshUrl("0;Url=/next")).toBe("/next");
  });

  it("strips surrounding quotes", () => {
    expect(parseMetaRefreshUrl("0;url='/next'")).toBe("/next");
    expect(parseMetaRefreshUrl(`0;url="/next"`)).toBe("/next");
  });

  it("accepts absolute URLs", () => {
    expect(parseMetaRefreshUrl("5;url=https://example.com/next")).toBe(
      "https://example.com/next"
    );
  });

  it("returns null for delay-only (no url= segment)", () => {
    expect(parseMetaRefreshUrl("5")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(parseMetaRefreshUrl(null)).toBeNull();
    expect(parseMetaRefreshUrl(undefined)).toBeNull();
    expect(parseMetaRefreshUrl("")).toBeNull();
  });

  it("returns null when url= value is empty", () => {
    expect(parseMetaRefreshUrl("0;url=")).toBeNull();
    expect(parseMetaRefreshUrl("0;url=   ")).toBeNull();
  });

  it("ignores unrelated parameters", () => {
    // Not a real directive, but shouldn't crash.
    expect(parseMetaRefreshUrl("0;foo=bar")).toBeNull();
  });

  it("stops unquoted URLs at the next parameter separator", () => {
    expect(parseMetaRefreshUrl("0;url=/next;")).toBe("/next");
    expect(parseMetaRefreshUrl("0;url=/next;foo=bar")).toBe("/next");
    expect(parseMetaRefreshUrl("0; url = /next ; charset=utf-8")).toBe("/next");
  });

  it("preserves semicolons inside a quoted URL", () => {
    // Rare but technically allowed — quotes delimit the value.
    expect(parseMetaRefreshUrl("0;url='/next;with-semi'")).toBe("/next;with-semi");
    expect(parseMetaRefreshUrl(`0;url="/a?x=1;y=2"`)).toBe("/a?x=1;y=2");
  });

  it("returns null on an unterminated quoted URL", () => {
    expect(parseMetaRefreshUrl("0;url='/next")).toBeNull();
    expect(parseMetaRefreshUrl(`0;url="/next`)).toBeNull();
  });
});

describe("resolvePageLinks", () => {
  const scrape = (over: Partial<RawPageLinks> = {}): RawPageLinks => ({
    hrefs: [],
    metaRefresh: [],
    baseUri: "https://example.com/docs/intro",
    ...over,
  });

  it("resolves relative hrefs against the page's base URI", () => {
    expect(resolvePageLinks(scrape({ hrefs: ["./next", "../up", "/root"] }))).toEqual([
      "https://example.com/docs/next",
      "https://example.com/up",
      "https://example.com/root",
    ]);
  });

  it("keeps absolute and cross-origin hrefs — origin filtering is the caller's job", () => {
    expect(resolvePageLinks(scrape({ hrefs: ["https://other.test/x"] }))).toEqual([
      "https://other.test/x",
    ]);
  });

  it("drops schemes that name an action rather than a page", () => {
    expect(
      resolvePageLinks(
        scrape({ hrefs: ["javascript:void(0)", "mailto:a@b.test", "tel:+150", "/real"] })
      )
    ).toEqual(["https://example.com/real"]);
  });

  it("drops those schemes whatever their case — URL schemes are case-insensitive", () => {
    expect(
      resolvePageLinks(scrape({ hrefs: ["JavaScript:void(0)", "MAILTO:a@b.test", "Tel:+150"] }))
    ).toEqual([]);
  });

  it("ignores blank and whitespace-only values", () => {
    expect(resolvePageLinks(scrape({ hrefs: ["", "   ", "\t\n"] }))).toEqual([]);
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(resolvePageLinks(scrape({ hrefs: ["  /padded  "] }))).toEqual([
      "https://example.com/padded",
    ]);
  });

  it("skips malformed values instead of failing the whole page", () => {
    expect(resolvePageLinks(scrape({ hrefs: ["http://", "/fine"] }))).toEqual([
      "https://example.com/fine",
    ]);
  });

  it("deduplicates URLs that resolve to the same absolute form", () => {
    expect(
      resolvePageLinks(scrape({ hrefs: ["/a", "./" + "../a", "https://example.com/a"] }))
    ).toEqual(["https://example.com/a"]);
  });

  it("preserves scrape order and puts meta-refresh targets last", () => {
    expect(
      resolvePageLinks(scrape({ hrefs: ["/one", "/two"], metaRefresh: ["0;url=/three"] }))
    ).toEqual([
      "https://example.com/one",
      "https://example.com/two",
      "https://example.com/three",
    ]);
  });

  it("routes meta-refresh content through the shared grammar", () => {
    // The crawler used to carry its own copy of this parsing inside the
    // browser-side scrape, so parseMetaRefreshUrl's tests governed nothing the
    // crawl actually ran. These cases exist to keep the two from drifting apart
    // again: each is a parseMetaRefreshUrl behaviour observed end-to-end.
    const resolved = (content: string) =>
      resolvePageLinks(scrape({ metaRefresh: [content] }));

    expect(resolved("0;url=/next")).toEqual(["https://example.com/next"]);
    expect(resolved("5 ;   URL = '/quoted'")).toEqual(["https://example.com/quoted"]);
    expect(resolved("0;url=/next;foo=bar")).toEqual(["https://example.com/next"]);
    expect(resolved("5")).toEqual([]);
    expect(resolved("0;url='/unterminated")).toEqual([]);
  });

  it("applies the scheme filter to meta-refresh targets too", () => {
    expect(resolvePageLinks(scrape({ metaRefresh: ["0;url=javascript:void(0)"] }))).toEqual([]);
  });
});
