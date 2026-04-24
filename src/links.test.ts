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
});
