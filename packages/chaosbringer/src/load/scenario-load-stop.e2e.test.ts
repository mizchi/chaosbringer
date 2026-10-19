import { afterEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { defineScenario } from "./scenario.js";
import { scenarioLoad } from "./scenario-load.js";
import { assertSlo } from "./slo.js";

/**
 * `scenarioLoad`'s stop on an unreachable base URL, against what a CI load
 * gate meets: a server that dies mid-run.
 */
const home = defineScenario({
  name: "home",
  steps: [
    {
      name: "open",
      run: async ({ page, baseUrl }) => {
        await page.goto(`${baseUrl}/`);
      },
    },
  ],
});

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(): Promise<TestServer> {
  const server = await startTestServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>ok</title><h1>ok</h1>");
  });
  servers.push(server);
  return server;
}

describe("scenarioLoad on a host that stops answering", () => {
  it("stops, and the SLO gate fails on the stop", async () => {
    // The stop used to turn the gate green: the few refused iterations
    // before it were an error rate under any threshold, and assertSlo read
    // nothing else.
    const server = await serve();
    const dies = setTimeout(() => void server.close(), 1_500);
    try {
      const { report } = await scenarioLoad({
        baseUrl: server.url,
        scenarios: [{ scenario: home, workers: 2 }],
        duration: "30s",
        thinkTime: { minMs: 50, maxMs: 100 },
      });
      expect(report.stopped).toMatchObject({ cause: "unreachable" });
      expect(report.totals.iterations).toBeGreaterThan(report.totals.iterationFailures);
      expect(() => assertSlo(report, { scenarios: { home: { errorRate: 0.5 } } })).toThrow(
        `[totals] run stopped early: base URL unreachable: ${server.url} (net::ERR_CONNECTION_REFUSED at ${server.url}/`,
      );
    } finally {
      clearTimeout(dies);
    }
  }, 60_000);
});
