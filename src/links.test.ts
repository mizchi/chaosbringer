import { describe, expect, it } from "vitest";
import { parseMetaRefreshUrl } from "./links.js";

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
