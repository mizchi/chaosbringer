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
import { test as base, expect } from "@playwright/test";
import { ChaosCrawler, COMMON_IGNORE_PATTERNS } from "./crawler.js";
/**
 * Create chaos fixture with custom options
 */
export function withChaos(defaultOptions = {}) {
    return {
        chaosOptions: [{}, { option: true }],
        chaos: async ({ page, chaosOptions }, use) => {
            const options = { ...defaultOptions, ...chaosOptions };
            // Get base URL from playwright config or options
            const baseUrl = options.baseUrl || page.context().pages()[0]?.url() || "http://localhost:3000";
            const crawler = new ChaosCrawler({
                baseUrl,
                maxPages: options.maxPages ?? 10,
                maxActionsPerPage: options.maxActionsPerPage ?? 5,
                ignoreErrorPatterns: options.ignoreErrorPatterns ?? COMMON_IGNORE_PATTERNS,
                blockExternalNavigation: options.blockExternalNavigation ?? true,
                actionWeights: options.actionWeights,
                headless: true,
            });
            const fixture = {
                crawler,
                async testPage(testPage, url) {
                    return crawler.testPage(testPage, url);
                },
                async crawl(startUrl) {
                    // Update base URL for crawling
                    crawler.options.baseUrl = startUrl;
                    crawler.baseOrigin = new URL(startUrl).origin;
                    return crawler.start();
                },
                expectNoErrors(result) {
                    if ("pages" in result) {
                        // CrawlReport
                        const allErrors = result.pages.flatMap((p) => p.errors);
                        if (allErrors.length > 0) {
                            const errorMessages = allErrors.map((e) => `[${e.type}] ${e.message}`).join("\n");
                            throw new Error(`Found ${allErrors.length} errors:\n${errorMessages}`);
                        }
                    }
                    else {
                        // PageResult
                        if (result.errors.length > 0) {
                            const errorMessages = result.errors.map((e) => `[${e.type}] ${e.message}`).join("\n");
                            throw new Error(`Found ${result.errors.length} errors:\n${errorMessages}`);
                        }
                    }
                },
                expectNoDeadLinks(result) {
                    const dead = result.summary.discovery?.deadLinks ?? [];
                    if (dead.length === 0)
                        return;
                    const lines = dead.map((d) => `  ${d.url} (${d.statusCode}) ← ${d.sourceUrl || "(initial)"}`);
                    throw new Error(`Found ${dead.length} dead links:\n${lines.join("\n")}`);
                },
            };
            await use(fixture);
        },
    };
}
/**
 * Pre-configured test with chaos fixture
 */
export const chaosTest = base.extend(withChaos());
/**
 * Helper to run chaos test on current page
 */
export async function runChaosTest(page, options = {}) {
    const url = page.url();
    const crawler = new ChaosCrawler({
        baseUrl: url,
        maxPages: 1,
        maxActionsPerPage: options.maxActionsPerPage ?? 5,
        ignoreErrorPatterns: options.ignoreErrorPatterns ?? COMMON_IGNORE_PATTERNS,
        blockExternalNavigation: options.blockExternalNavigation ?? true,
        actionWeights: options.actionWeights,
        headless: true,
    });
    return crawler.testPage(page, url);
}
/**
 * Expect helper for chaos results
 */
export const chaosExpect = {
    toHaveNoErrors(result) {
        if ("pages" in result) {
            const allErrors = result.pages.flatMap((p) => p.errors);
            expect(allErrors, `Expected no errors but found: ${JSON.stringify(allErrors)}`).toHaveLength(0);
        }
        else {
            expect(result.errors, `Expected no errors but found: ${JSON.stringify(result.errors)}`).toHaveLength(0);
        }
    },
    toHaveNoExceptions(result) {
        const errors = "pages" in result ? result.pages.flatMap((p) => p.errors) : result.errors;
        const exceptions = errors.filter((e) => e.type === "exception" || e.type === "unhandled-rejection");
        expect(exceptions, `Expected no exceptions but found: ${JSON.stringify(exceptions)}`).toHaveLength(0);
    },
    toLoadWithin(result, maxMs) {
        expect(result.loadTime, `Page load time ${result.loadTime}ms exceeded ${maxMs}ms`).toBeLessThanOrEqual(maxMs);
    },
    toHaveNoDeadLinks(result) {
        const dead = result.summary.discovery?.deadLinks ?? [];
        if (dead.length === 0) {
            expect(dead).toHaveLength(0);
            return;
        }
        const detail = dead
            .map((d) => `  ${d.url} (${d.statusCode}) ← ${d.sourceUrl || "(initial)"}`)
            .join("\n");
        expect(dead, `Expected no dead links but found ${dead.length}:\n${detail}`).toHaveLength(0);
    },
};
