import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { buildGithubAnnotations, formatGithubAnnotation } from "./github.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * An invariant whose check throws on a Playwright call stores that call's
 * error, and Playwright colours the call log it appends: the ANSI codes
 * reached the --github-annotations body and the text report's error lines.
 */
describe("an invariant whose check throws a Playwright error", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>home</title><p>home</p>`);
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it("records its message without ANSI codes", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${server.url}/`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      invariants: [
        {
          name: "has-nope",
          when: "afterLoad",
          check: async ({ page }) => {
            await page.locator("#nope").waitFor({ timeout: 300 });
            return true;
          },
        },
      ],
    }).start();
    const [violation] = report.pages[0]!.errors;
    expect(violation).toMatchObject({ type: "invariant-violation" });
    expect(violation!.message).toMatch(/^\[has-nope\] locator\.waitFor: Timeout 300ms exceeded\./);
    // The call log stays: an invariant has no stack to keep it on.
    expect(violation!.message).toContain("waiting for locator('#nope')");
    expect(violation!.message).not.toContain("\x1b");
    expect(buildGithubAnnotations(report).map(formatGithubAnnotation).join("\n")).not.toContain("\x1b");
  }, 60_000);
});
