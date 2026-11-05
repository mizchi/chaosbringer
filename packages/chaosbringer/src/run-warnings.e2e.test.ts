/**
 * `report.warnings` from real crawls: what was set up wrong for a run, which
 * used to go only to a logger that wrote nowhere without `logFile`.
 *
 * Each case is a setup that tested less than it said and passed in silence:
 * a dead fault rule on each layer, a sitemap that is not there or lists
 * nothing, a network rule aimed at a WebSocket (which no route sees), a
 * `flowDriver` whose step never matches, a driver that throws or picks out of
 * range, and a missing `chaos({ baseline })`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faults } from "@mizchi/playwright-faults";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chaos } from "./chaos.js";
import { ChaosCrawler } from "./crawler.js";
import { flowDriver } from "./drivers/flow-driver.js";
import type { Driver } from "./drivers/types.js";
import { unfiredFaults } from "./firings.js";
import { exitReasons } from "./reporter.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlerOptions } from "./types.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

describe("report.warnings", () => {
  let server: TestServer;
  let dir: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/empty-sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`);
        return;
      }
      if (path === "/elsewhere-sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>http://localhost:1/a</loc></url></urlset>`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      if (path === "/live") {
        // Opens a WebSocket to this server, which answers the handshake.
        res.end(`<!doctype html><title>live</title><p id="s">connecting</p><script>
          const ws = new WebSocket("ws://" + location.host + "/ws");
          ws.onopen = () => { document.getElementById("s").textContent = "open"; window.__cb_ws_open = 1; };
        </script>`);
        return;
      }
      res.end(`<!doctype html><title>plain</title><p>nothing to do here</p>`);
    });
    // The smallest WebSocket server: accept the handshake, keep the socket.
    server.server.on("upgrade", (req, socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    dir = mkdtempSync(join(tmpdir(), "cb-run-warnings-"));
  }, 60_000);

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = (over: Partial<CrawlerOptions> = {}): CrawlerOptions => ({
    baseUrl: `${server.url}/`,
    maxPages: 1,
    maxActionsPerPage: 0,
    headless: true,
    timeout: 10_000,
    seed: 1,
    ...over,
  });

  it("names a dead fault on every layer, in unfiredFaults' words", async () => {
    const report = await new ChaosCrawler(
      opts({
        faultInjection: [faults.abort({ urlPattern: /nope\.invalid/, name: "dead-network" })],
        runtimeFaults: [{ name: "dead-runtime", action: { kind: "flaky-fetch" }, urlPattern: /nope\.invalid/ }],
        lifecycleFaults: [
          { name: "dead-lifecycle", when: "beforeNavigation", urlPattern: /nope\.invalid/, action: { kind: "clear-storage", scopes: ["localStorage"] } },
        ],
        iframeFaults: [{ name: "dead-iframe", selector: "iframe.absent", action: { kind: "never-load" } }],
      }),
    ).start();
    expect(report.warnings?.map((w) => [w.code, w.layer, w.rule])).toEqual([
      ["fault-unmatched", "network", "dead-network"],
      ["fault-unmatched", "runtime", "dead-runtime"],
      ["fault-unmatched", "lifecycle", "dead-lifecycle"],
      ["fault-unmatched", "iframe", "dead-iframe"],
    ]);
    expect(report.warnings?.map((w) => w.message)).toEqual(unfiredFaults(report));
  }, 120_000);

  it("says nothing on a run whose fault fired", async () => {
    const report = await new ChaosCrawler(
      opts({ faultInjection: [faults.status(503, { urlPattern: /127\.0\.0\.1/, name: "lands" })] }),
    ).start();
    expect(report.warnings).toEqual([]);
  }, 120_000);

  it("names a rule an earlier one shadows, and a remote server that sent no fault header", async () => {
    const report = await new ChaosCrawler(
      opts({
        server: { mode: "remote" },
        faultInjection: [
          faults.delay(1, { urlPattern: /^https?:\/\//, name: "everything" }),
          faults.status(500, { urlPattern: /^http:\/\/127\.0\.0\.1:\d+\/api\//, name: "api" }),
        ],
      }),
    ).start();
    expect(report.warnings?.map((w) => [w.code, w.rule ?? w.layer])).toEqual([
      ["fault-shadowed", "api"],
      ["fault-unmatched", "api"],
      ["server-faults-unseen", "server"],
    ]);
    expect(report.warnings?.[0]?.message).toMatch(/^network fault "api" is shadowed by "everything" ahead of it/);
    expect(report.warnings?.[2]?.message).toMatch(/^server: \{ mode: "remote" \} saw no x-chaos-fault-\* response header/);
  }, 120_000);

  it("names a sitemap that could not be read, or that listed nothing on the origin", async () => {
    const missing = join(dir, "no-such-sitemap.xml");
    const unreadable = await new ChaosCrawler(opts({ seedFromSitemap: missing })).start();
    expect(unreadable.warnings).toEqual([
      {
        code: "sitemap-unreadable",
        message: expect.stringMatching(new RegExp(`^sitemap ${missing} could not be read \\(.*ENOENT.*\\), so the crawl started from the base URL alone$`)),
        source: missing,
        count: 1,
      },
    ]);
    const empty = await new ChaosCrawler(opts({ seedFromSitemap: `${server.url}/empty-sitemap.xml` })).start();
    expect(empty.warnings?.map((w) => [w.code, w.message])).toEqual([
      ["sitemap-empty", `sitemap ${server.url}/empty-sitemap.xml listed no URL, so the crawl started from the base URL alone`],
    ]);
    const elsewhere = await new ChaosCrawler(opts({ seedFromSitemap: `${server.url}/elsewhere-sitemap.xml` })).start();
    expect(elsewhere.warnings?.[0]?.message).toBe(
      `sitemap ${server.url}/elsewhere-sitemap.xml listed 1 URL(s), none of them on ${server.url} (1 on other origins), ` +
        "so the crawl started from the base URL alone",
    );
  }, 120_000);

  it("tells a network rule aimed at a WebSocket that Playwright's routes do not see one", async () => {
    const report = await new ChaosCrawler(
      opts({
        baseUrl: `${server.url}/live`,
        faultInjection: [
          faults.abort({ urlPattern: /\/ws$/, name: "ws-path" }),
          faults.abort({ urlPattern: "^wss?://", name: "ws-scheme" }),
        ],
      }),
    ).start();
    // The socket opened: the abort never reached it.
    expect(report.pages[0]?.errors).toEqual([]);
    const wsUrl = `ws://${new URL(server.url).host}/ws`;
    expect(report.faultInjections).toEqual([
      { rule: "ws-path", matched: 0, injected: 0, webSocket: { connections: 1, first: wsUrl, webSocketOnly: false } },
      { rule: "ws-scheme", matched: 0, injected: 0, webSocket: { connections: 1, first: wsUrl, webSocketOnly: true } },
    ]);
    expect(report.warnings?.map((w) => [w.code, w.rule])).toEqual([
      ["fault-websocket", "ws-path"],
      ["fault-websocket", "ws-scheme"],
    ]);
    expect(report.warnings?.[0]?.message).toBe(
      `network fault "ws-path" never matched anything, and the run's pages opened 1 WebSocket connection(s) its pattern ` +
        `matches (first: ${wsUrl}): network faults route HTTP requests, and Playwright's routes do not see WebSocket ` +
        "traffic, so no network fault reaches it",
    );
  }, 120_000);

  it("names a flow that ended mid-journey, and a driver that threw or picked out of range, once each", async () => {
    const flow = await new ChaosCrawler(
      opts({
        maxActionsPerPage: 1,
        driver: flowDriver({ name: "checkout", steps: [{ name: "pay", urlPattern: /chekout/, run: async () => {} }] }),
      }),
    ).start();
    expect(flow.warnings).toEqual([
      {
        code: "flow-incomplete",
        message: 'flow "checkout" ended at step 0/1: "pay" never ran, its urlPattern / when never matched a page the crawl reached',
        driver: "checkout",
        count: 1,
      },
    ]);

    const throwing: Driver = {
      name: "boom",
      selectAction: async () => {
        throw new Error("no model");
      },
    };
    const threw = await new ChaosCrawler(opts({ maxActionsPerPage: 1, driver: throwing })).start();
    // Three attempts for one action, one entry.
    expect(threw.warnings).toEqual([
      {
        code: "driver-threw",
        message: 'driver "boom" threw in selectAction (no model), so the step was skipped',
        driver: "boom",
        url: `${server.url}/`,
        count: 3,
      },
    ]);

    const far: Driver = { name: "far", selectAction: async () => ({ kind: "select", index: 999 }) };
    const outOfRange = await new ChaosCrawler(opts({ maxActionsPerPage: 1, driver: far })).start();
    expect(outOfRange.warnings?.map((w) => [w.code, w.count])).toEqual([["driver-out-of-range", 3]]);
  }, 120_000);

  describe("chaos()", () => {
    const setup = () => ({
      baseUrl: `${server.url}/`,
      maxPages: 1,
      maxActionsPerPage: 1,
      headless: true,
      seed: 1,
      strict: true,
      driver: flowDriver({ steps: [{ name: "checkout", urlPattern: /chekout/, run: async () => {} }] }),
      faultInjection: [faults.status(500, { name: "api-500", urlPattern: "/api/nope" })],
      seedFromSitemap: join(dir, "no-such-sitemap.xml"),
    });

    it("returns the warnings with passed true, and fails on them under failOnWarnings", async () => {
      const passed = await chaos(setup());
      expect(passed.passed).toBe(true);
      expect(passed.warnings.map((w) => w.code)).toEqual(["sitemap-unreadable", "fault-unmatched", "flow-incomplete"]);
      expect(passed.report.warnings).toBe(passed.warnings);

      const failed = await chaos({ ...setup(), failOnWarnings: true });
      expect([failed.passed, failed.exitCode]).toEqual([false, 1]);
      expect(exitReasons(failed.report, { strict: true, warnings: true })).toEqual([
        `--fail-on-warnings: 3 warnings (first: ${failed.warnings[0]?.message})`,
      ]);
    }, 120_000);

    it("warns on a missing baseline, and refuses the run under baselineMissing: \"fail\" before anything starts", async () => {
      const missing = join(dir, "no-such-baseline.json");
      const run = await chaos({ baseUrl: `${server.url}/`, maxPages: 1, maxActionsPerPage: 0, headless: true, baseline: missing, baselineStrict: true });
      expect([run.passed, run.report.diff]).toEqual([true, undefined]);
      expect(run.warnings).toEqual([
        {
          code: "baseline-missing",
          message: expect.stringMatching(new RegExp(`^baseline ${missing} not found, so no diff was made`)),
          source: missing,
          count: 1,
        },
      ]);

      let setupRan = false;
      await expect(
        chaos({
          baseUrl: `${server.url}/`,
          baseline: missing,
          baselineMissing: "fail",
          setup: async () => {
            setupRan = true;
          },
        }),
      ).rejects.toThrow(`chaosbringer: baseline ${missing} not found, and baselineMissing: "fail" refuses a run without one`);
      expect(setupRan).toBe(false);
      await expect(chaos({ baseUrl: `${server.url}/`, baselineMissing: "nope" as never })).rejects.toThrow(
        /"baselineMissing" must be one of warn, fail/,
      );

      const present = join(dir, "baseline.json");
      writeFileSync(present, JSON.stringify(run.report));
      const diffed = await chaos({ baseUrl: `${server.url}/`, maxPages: 1, maxActionsPerPage: 0, headless: true, baseline: present, baselineMissing: "fail" });
      expect(diffed.report.diff).toBeDefined();
      expect(diffed.warnings).toEqual([]);
    }, 120_000);
  });
});
