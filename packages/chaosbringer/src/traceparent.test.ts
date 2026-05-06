import { describe, expect, it } from "vitest";
import { parseTraceparent } from "./crawler.js";

describe("parseTraceparent", () => {
  it("parses a well-formed traceparent into traceId and spanId", () => {
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    expect(parseTraceparent(tp)).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
    });
  });

  it("is case-insensitive on input but lowercases the output", () => {
    const tp = "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01";
    const got = parseTraceparent(tp);
    expect(got?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(got?.spanId).toBe("b7ad6b7169203331");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(parseTraceparent("  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01\n")).not.toBeNull();
  });

  it.each([
    ["empty", ""],
    ["wrong segment count", "00-trace-span"],
    ["short trace id", "00-deadbeef-b7ad6b7169203331-01"],
    ["short span id", "00-0af7651916cd43dd8448eb211c80319c-cafe-01"],
    ["non-hex char", "00-0af7651916cd43dd8448eb211c80319g-b7ad6b7169203331-01"],
  ])("returns null for malformed input (%s)", (_label, input) => {
    expect(parseTraceparent(input)).toBeNull();
  });
});
