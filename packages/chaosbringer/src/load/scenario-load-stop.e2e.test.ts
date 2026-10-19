import { afterEach, describe, expect, it } from "vitest";
import { faults } from "../faults.js";
import { startTestServer, type TestServer } from "../test-server.test-helpers.js";
import { defineScenario } from "./scenario.js";
import { scenarioLoad } from "./scenario-load.js";
import { assertSlo } from "./slo.js";

/**
 * `scenarioLoad`'s stop on an unreachable base URL, against what a CI load
 * gate meets: a server that dies mid-run, and a chaos run whose own faults
 * abort the document with a connection-level code while the host is up.
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

/** The document only: a rule on it fails `page.goto` the way a down host does. */
const DOCUMENT = /127\.0\.0\.1:\d+\/$/;

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

  it("does not stop on a fault rule's connection-level abort while the host is up", async () => {
    // Every navigation aborted with ERR_CONNECTION_REFUSED by the run's own
    // fault: it used to stop after 3 iterations as "base URL unreachable".
    const server = await serve();
    const { report, faultStats } = await scenarioLoad({
      baseUrl: server.url,
      scenarios: [{ scenario: home, workers: 1 }],
      duration: "1500ms",
      thinkTime: { distribution: "none" },
      faultInjection: [faults.abort({ urlPattern: DOCUMENT, errorCode: "connectionrefused", name: "refuse" })],
    });
    expect(report.stopped).toBeUndefined();
    expect(report.totals.iterations).toBeGreaterThan(3);
    expect(report.totals.iterationFailures).toBe(report.totals.iterations);
    expect(report.errors[0]?.message).toContain("net::ERR_CONNECTION_REFUSED");
    expect(faultStats).toEqual([expect.objectContaining({ rule: "refuse", injected: report.totals.iterations })]);
  }, 60_000);

  it("still stops on a host that is down, whatever the faults inject", async () => {
    // An injected abort is left out of the count, not a reset: the refusals
    // the host itself gives still add up to the stop.
    const closed = await serve();
    servers.pop();
    await closed.close();
    const { report } = await scenarioLoad({
      baseUrl: closed.url,
      scenarios: [{ scenario: home, workers: 1 }],
      duration: "30s",
      thinkTime: { distribution: "none" },
      faultInjection: [faults.abort({ urlPattern: DOCUMENT, errorCode: "connectionrefused", probability: 0.5 })],
    });
    expect(report.stopped).toMatchObject({ cause: "unreachable" });
    expect(report.totals.iterations).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
