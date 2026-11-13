import { describe, expect, it } from "vitest";
import { sameDocumentTarget } from "./perf.js";

describe("sameDocumentTarget", () => {
  it.each([
    ["http://x.test/a", "http://x.test/a#top", true],
    ["http://x.test/a#one", "http://x.test/a#two", true],
    ["http://x.test/a?q=1", "http://x.test/a?q=1#", true],
    // No fragment: a load, even of the URL already loaded.
    ["http://x.test/a", "http://x.test/a", false],
    ["http://x.test/a#one", "http://x.test/a", false],
    ["http://x.test/a", "http://x.test/b#top", false],
    ["http://x.test/a?q=1", "http://x.test/a?q=2#top", false],
    ["about:blank", "http://x.test/a#top", false],
    ["about:blank", "not a url", false],
  ])("%s -> %s: %s", (current, target, expected) => {
    expect(sameDocumentTarget(current, target)).toBe(expected);
  });
});
