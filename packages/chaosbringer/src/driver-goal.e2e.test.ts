import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { aiDriver } from "./drivers/ai-driver.js";
import type { Driver, DriverProviderInput, DriverStep } from "./drivers/types.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * `CrawlerOptions.driverGoal` was validated and documented as the goal an
 * AI driver is given, and then never read: `new ChaosCrawler({ driver:
 * aiDriver(...), driverGoal })` dropped it without a word. The provider here
 * records what it was asked with, so the test reads the goal off the input
 * the model would have seen.
 */
const PAGE = `<!doctype html><title>goal</title><main>
  <button type="button" id="a">One</button>
  <button type="button" id="b">Two</button>
</main>`;

describe("CrawlerOptions.driverGoal", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  const crawl = (driver: Driver, driverGoal?: string) =>
    new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      timeout: 5000,
      logLevel: "error",
      driver,
      ...(driverGoal !== undefined ? { driverGoal } : {}),
    }).start();

  const recording = (goal?: string) => {
    const inputs: DriverProviderInput[] = [];
    const driver = aiDriver({
      provider: {
        name: "test/recording",
        async selectAction(input) {
          inputs.push(input);
          return { index: 0, reasoning: "first" };
        },
      },
      ...(goal !== undefined ? { goal } : {}),
    });
    return { driver, inputs };
  };

  it("reaches the AI driver's provider as its goal", async () => {
    const { driver, inputs } = recording();
    await crawl(driver, "find form validation bugs");
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.map((i) => i.goal)).toEqual(inputs.map(() => "find form validation bugs"));
  }, 60_000);

  it("is on every DriverStep, for a custom driver to read", async () => {
    const goals: (string | undefined)[] = [];
    const driver: Driver = {
      name: "goal-reader",
      async selectAction(step: DriverStep) {
        goals.push(step.goal);
        return { kind: "skip" };
      },
    };
    await crawl(driver, "check out");
    expect(goals.length).toBeGreaterThan(0);
    expect(new Set(goals)).toEqual(new Set(["check out"]));
  }, 60_000);

  it("gives way to the goal aiDriver was built with", async () => {
    const { driver, inputs } = recording("its own goal");
    await crawl(driver, "the crawl's goal");
    expect(inputs.length).toBeGreaterThan(0);
    expect(new Set(inputs.map((i) => i.goal))).toEqual(new Set(["its own goal"]));
  }, 60_000);
});
