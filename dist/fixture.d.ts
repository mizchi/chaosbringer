/**
 * Playwright Test Fixture for Chaos Testing
 *
 * Usage:
 * ```typescript
 * import { test, expect } from '@playwright/test';
 * import { chaosTest, withChaos } from 'chaosbringer/fixture';
 *
 * // Option 1: Use chaosTest directly
 * chaosTest('chaos test homepage', async ({ page, chaos }) => {
 *   const result = await chaos.testPage(page, 'http://localhost:3000');
 *   expect(result.errors).toHaveLength(0);
 * });
 *
 * // Option 2: Extend your existing test
 * const test = base.extend(withChaos());
 * test('my test', async ({ page, chaos }) => { ... });
 * ```
 */
import { type Page } from "@playwright/test";
import { ChaosCrawler } from "./crawler.js";
import type { ChaosTestOptions, PageResult, CrawlReport } from "./types.js";
export interface ChaosFixture {
    /** Test a single page with chaos testing */
    testPage(page: Page, url: string): Promise<PageResult>;
    /** Crawl multiple pages starting from a URL */
    crawl(startUrl: string): Promise<CrawlReport>;
    /** Assert no errors were found */
    expectNoErrors(result: PageResult | CrawlReport): void;
    /**
     * Assert the crawl discovered no dead links. Prints each dead link's
     * source page so the reviewer can find the broken anchor without
     * cross-referencing the full report.
     */
    expectNoDeadLinks(result: CrawlReport): void;
    /** Get the underlying crawler instance */
    crawler: ChaosCrawler;
}
export interface ChaosFixtures {
    chaos: ChaosFixture;
    chaosOptions: ChaosTestOptions;
}
/**
 * Create chaos fixture with custom options
 */
export declare function withChaos(defaultOptions?: ChaosTestOptions): {
    chaosOptions: [ChaosTestOptions, {
        option: true;
    }];
    chaos: ({ page, chaosOptions }: {
        page: Page;
        chaosOptions: ChaosTestOptions;
    }, use: (fixture: ChaosFixture) => Promise<void>) => Promise<void>;
};
/**
 * Pre-configured test with chaos fixture
 */
export declare const chaosTest: import("playwright/test").TestType<import("playwright/test").PlaywrightTestArgs & import("playwright/test").PlaywrightTestOptions & ChaosFixtures, import("playwright/test").PlaywrightWorkerArgs & import("playwright/test").PlaywrightWorkerOptions>;
/**
 * Helper to run chaos test on current page
 */
export declare function runChaosTest(page: Page, options?: ChaosTestOptions): Promise<PageResult>;
/**
 * Expect helper for chaos results
 */
export declare const chaosExpect: {
    toHaveNoErrors(result: PageResult | CrawlReport): void;
    toHaveNoExceptions(result: PageResult | CrawlReport): void;
    toLoadWithin(result: PageResult, maxMs: number): void;
    toHaveNoDeadLinks(result: CrawlReport): void;
};
//# sourceMappingURL=fixture.d.ts.map