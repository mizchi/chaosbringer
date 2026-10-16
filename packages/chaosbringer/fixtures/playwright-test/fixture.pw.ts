/**
 * `chaosbringer/fixture` under the real Playwright Test runner, against the
 * site `src/fixture.e2e.test.ts` serves. The runner is the point: it is what
 * hands the fixture `baseURL` and `testInfo`, and a fixture called by hand
 * would test neither.
 *
 * Pages are load-only (`maxActionsPerPage: 0`): what is under test is which
 * URLs the crawler visits and what it reports, not what it clicks.
 */
import { expect } from "@playwright/test";
import { faults } from "../../src/faults.js";
import { chaosTest, runChaosTest } from "../../src/fixture.js";
import type { ChaosTestOptions } from "../../src/types.js";

/** The same site under a second origin, for the explicit-`baseUrl` case. */
const ALT_URL = process.env.CHAOS_FIXTURE_ALT_URL ?? "";

const LOAD_ONLY: ChaosTestOptions = { maxPages: 2, maxActionsPerPage: 0 };

chaosTest.use({ chaosOptions: LOAD_ONLY });

chaosTest.describe("a relative URL resolves against baseURL", () => {
  // These threw `Invalid URL`: the base was read from the first page's URL,
  // which is `about:blank` until something navigates.
  chaosTest("in crawl()", async ({ chaos, baseURL }) => {
    const report = await chaos.crawl("/");
    expect(report.baseUrl).toBe(`${baseURL}/`);
    expect(report.pages.map((p) => p.url)).toEqual([`${baseURL}/`, `${baseURL}/about`]);
  });

  chaosTest("in testPage()", async ({ page, chaos, baseURL }) => {
    const result = await chaos.testPage(page, "/about");
    expect(result.url).toBe(`${baseURL}/about`);
    expect(result.statusCode).toBe(200);
  });

  chaosTest.describe("unless chaosOptions.baseUrl is set", () => {
    chaosTest.use({ chaosOptions: { ...LOAD_ONLY, baseUrl: ALT_URL } });

    chaosTest("which wins", async ({ page, chaos, baseURL }) => {
      expect(ALT_URL).not.toBe(baseURL);
      const result = await chaos.testPage(page, "/about");
      expect(result.url).toBe(`${ALT_URL}/about`);
    });
  });

  chaosTest("and with neither, is refused by name", { tag: "@no-base-url" }, async ({ chaos, baseURL }) => {
    expect(baseURL).toBeUndefined();
    await expect(chaos.crawl("/")).rejects.toThrow(/chaos\.crawl\("\/"\) has no base to resolve against/);
  });
});

chaosTest("crawl() attaches its report", async ({ chaos }) => {
  const report = await chaos.crawl("/");
  const attached = chaosTest.info().attachments.filter((a) => a.name === "chaos-report.json");
  expect(attached).toHaveLength(1);
  expect(attached[0]?.contentType).toBe("application/json");
  expect(JSON.parse(attached[0]?.body?.toString() ?? "null")).toEqual(JSON.parse(JSON.stringify(report)));
});

chaosTest.describe("strict", () => {
  chaosTest.use({ chaosOptions: { ...LOAD_ONLY, maxPages: 1, strict: true } });

  // `strict` was declared and documented and never read: each of these passed.
  chaosTest("fails a crawl() that --strict would fail, after attaching it", async ({ chaos }) => {
    await expect(chaos.crawl("/boom")).rejects.toThrow(/fails under strict[\s\S]*\[console\] boom/);
    const attached = chaosTest.info().attachments.map((a) => a.name);
    expect(attached).toEqual(["chaos-report.json"]);
  });

  chaosTest("fails a testPage() that --strict would fail", async ({ page, chaos }) => {
    await expect(chaos.testPage(page, "/boom")).rejects.toThrow(/fails under strict[\s\S]*\[console\] boom/);
  });

  chaosTest("fails runChaosTest() the same way", async ({ page }) => {
    await page.goto("/boom");
    await expect(runChaosTest(page, { maxActionsPerPage: 0, strict: true })).rejects.toThrow(
      /runChaosTest\(.*\/boom\) fails under strict/,
    );
  });

  chaosTest("passes a clean run", async ({ page, chaos }) => {
    expect((await chaos.crawl("/")).totalErrors).toBe(0);
    expect((await chaos.testPage(page, "/about")).errors).toEqual([]);
  });
});

chaosTest("without strict, the same error is only reported", async ({ chaos }) => {
  const report = await chaos.crawl("/boom");
  expect(report.summary.consoleErrors).toBe(1);
});

chaosTest.describe("chaosOptions reach the crawler", () => {
  chaosTest.use({
    chaosOptions: {
      ...LOAD_ONLY,
      maxPages: 1,
      seed: 7,
      faultInjection: [faults.status(503, { urlPattern: /\/api\/stock/, name: "stock-down" })],
      lifecycleFaults: [
        { name: "wipe", when: "afterLoad", action: { kind: "clear-storage", scopes: ["localStorage"] } },
      ],
      runtimeFaults: [{ name: "skew", action: { kind: "clock-skew", skewMs: 60_000 } }],
      invariants: [
        {
          name: "stock-shown",
          check: async ({ page }) =>
            (await page.getByRole("status").textContent()) !== "Stock unavailable" || "no stock count",
        },
      ],
    },
  });

  // None of these could be passed before: the fixture built its crawler
  // from a fixed list of options that had none of them.
  chaosTest("in crawl()", async ({ chaos }) => {
    const report = await chaos.crawl("/stock");
    expect(report.seed).toBe(7);
    expect(report.faultInjections).toEqual([{ rule: "stock-down", matched: 1, injected: 1 }]);
    expect(report.lifecycleFaults?.map((f) => [f.name, f.fired])).toEqual([["wipe", 1]]);
    expect(report.runtimeFaults?.map((f) => [f.rule, f.fired])).toEqual([["skew", 1]]);
    expect(report.pages[0]?.errors.map((e) => e.type)).toContain("invariant-violation");
  });

  chaosTest("in testPage()", async ({ page, chaos }) => {
    const result = await chaos.testPage(page, "/stock");
    expect(chaos.crawler.getSeed()).toBe(7);
    expect(chaos.crawler.getFaultStats()).toEqual([{ rule: "stock-down", matched: 1, injected: 1 }]);
    expect(result.errors.map((e) => e.message)).toContain("[stock-shown] no stock count");
    await expect(page.getByRole("status")).toHaveText("Stock unavailable");

    // The rule is routed on this page, and stays routed after testPage().
    await page.goto("/stock");
    await expect(page.getByRole("status")).toHaveText("Stock unavailable");
  });
});
