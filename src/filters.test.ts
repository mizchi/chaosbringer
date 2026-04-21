import { describe, it, expect } from "vitest";
import {
  matchesAnyPattern,
  matchesSpaPattern,
  isExternalUrl,
  escapeSelector,
  summarizePages,
  normalizeUrl,
} from "./filters.js";
import type { PageResult } from "./types.js";

describe("matchesAnyPattern", () => {
  it("returns false when no patterns given", () => {
    expect(matchesAnyPattern("anything", undefined)).toBe(false);
    expect(matchesAnyPattern("anything", [])).toBe(false);
  });

  it("matches when any pattern hits", () => {
    expect(matchesAnyPattern("/api/users", ["\\bapi\\b", "nope"])).toBe(true);
  });

  it("returns false when no pattern hits", () => {
    expect(matchesAnyPattern("/home", ["\\bapi\\b"])).toBe(false);
  });

  it("respects regex flags (case insensitive)", () => {
    expect(matchesAnyPattern("Analytics failed", ["analytics"], "i")).toBe(true);
    expect(matchesAnyPattern("Analytics failed", ["analytics"])).toBe(false);
  });

  it("skips invalid regex patterns without throwing", () => {
    expect(matchesAnyPattern("/home", ["(unterminated", "home"])).toBe(true);
    expect(matchesAnyPattern("/home", ["(unterminated"])).toBe(false);
  });
});

describe("matchesSpaPattern", () => {
  it("returns the first matching pattern string", () => {
    expect(matchesSpaPattern("/browser_router/deep", ["browser_router", "hash"])).toBe(
      "browser_router"
    );
  });

  it("returns null when nothing matches", () => {
    expect(matchesSpaPattern("/static", ["browser_router"])).toBeNull();
  });

  it("returns null for empty / undefined patterns", () => {
    expect(matchesSpaPattern("/x", undefined)).toBeNull();
    expect(matchesSpaPattern("/x", [])).toBeNull();
  });

  it("skips invalid regex patterns", () => {
    expect(matchesSpaPattern("/spa", ["(bad", "spa"])).toBe("spa");
  });
});

describe("isExternalUrl", () => {
  const base = "http://localhost:3000";

  it("returns false for same origin", () => {
    expect(isExternalUrl("http://localhost:3000/path", base)).toBe(false);
  });

  it("returns true for different host", () => {
    expect(isExternalUrl("http://example.com/", base)).toBe(true);
  });

  it("returns true for different port", () => {
    expect(isExternalUrl("http://localhost:4000/", base)).toBe(true);
  });

  it("returns true for different scheme", () => {
    expect(isExternalUrl("https://localhost:3000/", base)).toBe(true);
  });

  it("returns false for invalid URLs", () => {
    expect(isExternalUrl("not a url", base)).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("collapses bare host and host-with-slash to the same form", () => {
    expect(normalizeUrl("http://127.0.0.1:4455")).toBe(normalizeUrl("http://127.0.0.1:4455/"));
  });

  it("strips trailing slash on non-root paths", () => {
    expect(normalizeUrl("http://x/about/")).toBe("http://x/about");
    expect(normalizeUrl("http://x/a/b/")).toBe("http://x/a/b");
  });

  it("keeps root as /", () => {
    expect(normalizeUrl("http://x/")).toMatch(/\/$/);
  });

  it("drops fragment", () => {
    expect(normalizeUrl("http://x/a#anchor")).toBe("http://x/a");
  });

  it("lowercases host", () => {
    expect(normalizeUrl("http://EXAMPLE.COM/X")).toBe("http://example.com/X");
  });

  it("passes invalid URLs through unchanged", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("escapeSelector", () => {
  it("escapes double quotes", () => {
    expect(escapeSelector('say "hi"')).toBe('say \\"hi\\"');
  });

  it("replaces newlines with spaces", () => {
    expect(escapeSelector("line1\nline2")).toBe("line1 line2");
  });

  it("truncates to 50 chars", () => {
    const input = "x".repeat(60);
    expect(escapeSelector(input)).toHaveLength(50);
  });
});

function makeResult(overrides: Partial<PageResult> = {}): PageResult {
  return {
    url: "http://localhost/p",
    status: "success",
    loadTime: 100,
    errors: [],
    warnings: [],
    links: [],
    ...overrides,
  };
}

describe("summarizePages", () => {
  it("returns zeros for empty input", () => {
    const s = summarizePages([]);
    expect(s.successPages).toBe(0);
    expect(s.errorPages).toBe(0);
    expect(s.avgLoadTime).toBe(0);
    expect(s.avgMetrics).toBeUndefined();
  });

  it("counts pages by status", () => {
    const s = summarizePages([
      makeResult({ status: "success" }),
      makeResult({ status: "success" }),
      makeResult({ status: "error" }),
      makeResult({ status: "timeout" }),
      makeResult({ status: "recovered" }),
    ]);
    expect(s.successPages).toBe(2);
    expect(s.errorPages).toBe(1);
    expect(s.timeoutPages).toBe(1);
    expect(s.recoveredPages).toBe(1);
  });

  it("counts errors by type across all pages", () => {
    const s = summarizePages([
      makeResult({
        errors: [
          { type: "console", message: "a", timestamp: 0 },
          { type: "network", message: "b", timestamp: 0 },
        ],
      }),
      makeResult({
        errors: [
          { type: "exception", message: "c", timestamp: 0 },
          { type: "unhandled-rejection", message: "d", timestamp: 0 },
          { type: "console", message: "e", timestamp: 0 },
          { type: "invariant-violation", message: "f", timestamp: 0 },
          { type: "invariant-violation", message: "g", timestamp: 0 },
        ],
      }),
    ]);
    expect(s.consoleErrors).toBe(2);
    expect(s.networkErrors).toBe(1);
    expect(s.jsExceptions).toBe(1);
    expect(s.unhandledRejections).toBe(1);
    expect(s.invariantViolations).toBe(2);
  });

  it("averages load times", () => {
    const s = summarizePages([
      makeResult({ loadTime: 100 }),
      makeResult({ loadTime: 200 }),
      makeResult({ loadTime: 300 }),
    ]);
    expect(s.avgLoadTime).toBe(200);
  });

  it("averages performance metrics, ignoring missing values", () => {
    const s = summarizePages([
      makeResult({ metrics: { ttfb: 10, fcp: 100, lcp: 200 } }),
      makeResult({ metrics: { ttfb: 30, fcp: 300 } }),
    ]);
    expect(s.avgMetrics).toEqual({ ttfb: 20, fcp: 200, lcp: 200 });
  });

  it("leaves avgMetrics undefined when no page has metrics", () => {
    const s = summarizePages([makeResult({}), makeResult({})]);
    expect(s.avgMetrics).toBeUndefined();
  });

  it("passes discovery through unchanged", () => {
    const discovery = {
      extractedLinks: 5,
      clickedLinks: 2,
      uniquePages: 3,
      deadLinks: [],
      spaIssues: [],
    };
    const s = summarizePages([], discovery);
    expect(s.discovery).toBe(discovery);
  });
});
