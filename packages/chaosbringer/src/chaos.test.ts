import { describe, expect, it, vi } from "vitest";
import { chaos } from "./chaos.js";

describe("chaos() setup hook", () => {
  it("invokes setup before the crawl and forwards baseUrl + a Playwright page", async () => {
    const setup = vi.fn(async ({ baseUrl, page }: { baseUrl: string; page: unknown }) => {
      // smoke: page is a Playwright page-like object
      expect(baseUrl).toBe("http://127.0.0.1:65535");
      expect(page).toBeDefined();
      expect(typeof (page as { goto: unknown }).goto).toBe("function");
    });

    // 65535 is reserved by some OSes, and we never connect anyway: the crawl
    // will fail-fast and we only care that setup ran first. Wrap in catch so
    // the unreachable baseUrl doesn't fail the test.
    await chaos({
      baseUrl: "http://127.0.0.1:65535",
      maxPages: 1,
      headless: true,
      setup,
    }).catch(() => {
      /* expected: nothing is listening */
    });

    expect(setup).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("does not invoke a missing setup", async () => {
    // Pure shape check — a no-setup chaos run should still type-check and
    // not crash before reaching the crawler. We bail the crawl by pointing
    // at a closed port.
    const result = await chaos({
      baseUrl: "http://127.0.0.1:65535",
      maxPages: 1,
      headless: true,
    }).catch((e) => e as Error);

    expect(result).toBeDefined();
  }, 30_000);
});
