import { describe, expect, it } from "vitest";
import { crawlerErrorType } from "./error-text.js";

describe("crawlerErrorType", () => {
  // A `navigation` error leaves summary.jsExceptions, --strict and scan's
  // findings: a wrong one hides a real error from all three.
  it("is navigation for whatever the load threw, prefix or not", () => {
    expect(crawlerErrorType("page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:4000/", true)).toBe("navigation");
    // The adaptive settle's own wait failing has no `page.goto:` prefix.
    expect(crawlerErrorType("page.waitForFunction: Timeout 30000ms exceeded.", true)).toBe("navigation");
  });

  it("is navigation for a navigation call that failed after the load", () => {
    expect(crawlerErrorType("page.reload: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:4000/", false)).toBe("navigation");
    expect(crawlerErrorType("page.goBack: Timeout 5000ms exceeded.", false)).toBe("navigation");
    expect(crawlerErrorType("Navigation to \"http://127.0.0.1:4000/a\" is interrupted by another navigation", false)).toBe(
      "navigation",
    );
  });

  it("is exception for anything else that escaped after the load", () => {
    expect(crawlerErrorType("hook failed", false)).toBe("exception");
    expect(crawlerErrorType("page.evaluate: TypeError: x is undefined", false)).toBe("exception");
    expect(crawlerErrorType("page.screenshot: Timeout 30000ms exceeded.", false)).toBe("exception");
  });
});
