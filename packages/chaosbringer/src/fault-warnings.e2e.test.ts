import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { faults } from "@mizchi/playwright-faults";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

/**
 * The run-end warning has to reach the logger, on all four layers.
 *
 * `faultWarnings` is unit-tested against hand-built reports, which pins what
 * the warning *says* but not that anything says it. The bug this file guards
 * was exactly in the gap between those: the crawler walked its own
 * `compiledFaultRules` and warned on `matched === 0`, so a runtime, lifecycle
 * or iframe fault that never fired ended the run in silence — and the
 * documented `fault_rule_unmatched` event had no test at all, on any layer.
 *
 * So this drives a real crawl with one dead fault per layer and reads the log
 * the user would read. Every fault here is deliberately unmatchable: the
 * patterns name a host the page never contacts and a selector the page does
 * not contain.
 */
describe("run-end fault warnings reach the logger", () => {
  let server: http.Server;
  let base: string;
  let logDir: string;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><title>warnings</title><body><p>nothing to do here</p></body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    logDir = mkdtempSync(join(tmpdir(), "cb-warn-"));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The `warn`-level events a finished crawl wrote, in order. */
  async function warningsFrom(logFile: string, crawler: ChaosCrawler) {
    await crawler.start();
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { level: string; event: string; data?: Record<string, unknown> })
      .filter((e) => e.level === "warn");
  }

  it("warns once per layer when a fault matched nothing", async () => {
    const logFile = join(logDir, "unmatched.jsonl");
    const warnings = await warningsFrom(
      logFile,
      new ChaosCrawler({
        baseUrl: base,
        maxPages: 1,
        maxActionsPerPage: 0,
        headless: true,
        timeout: 5000,
        logFile,
        logLevel: "warn",
        faultInjection: [faults.abort({ urlPattern: /nope\.invalid/, name: "dead-network" })],
        runtimeFaults: [
          { name: "dead-runtime", action: { kind: "flaky-fetch" }, urlPattern: /nope\.invalid/ },
        ],
        lifecycleFaults: [
          {
            name: "dead-lifecycle",
            when: "beforeNavigation",
            urlPattern: /nope\.invalid/,
            action: { kind: "clear-storage", scopes: ["localStorage"] },
          },
        ],
        iframeFaults: [
          { name: "dead-iframe", selector: "iframe.absent", action: { kind: "never-load" } },
        ],
      }),
    );

    // Before the fix only `dead-network` appeared here. The other three were
    // configured, never fired, and said nothing.
    expect(
      warnings
        .filter((w) => w.event === "fault_rule_unmatched")
        .map((w) => `${w.data?.layer}:${w.data?.rule}`)
        .sort(),
    ).toEqual([
      "iframe:dead-iframe",
      "lifecycle:dead-lifecycle",
      "network:dead-network",
      "runtime:dead-runtime",
    ]);
  }, 120_000);

  it("warns that a matched fault was declined, not that it never matched", async () => {
    // `probability: 0` is the smallest firing policy that always says no. The
    // pattern is right and the request happens, so this is the diagnosis that
    // had no event of its own: `matched: 1, injected: 0` used to look exactly
    // like a fault nobody configured.
    const logFile = join(logDir, "declined.jsonl");
    const warnings = await warningsFrom(
      logFile,
      new ChaosCrawler({
        baseUrl: base,
        maxPages: 1,
        maxActionsPerPage: 0,
        headless: true,
        timeout: 5000,
        logFile,
        logLevel: "warn",
        faultInjection: [
          faults.abort({ urlPattern: /127\.0\.0\.1/, probability: 0, name: "declined" }),
        ],
      }),
    );

    const declined = warnings.filter((w) => w.event === "fault_rule_unfired");
    expect(declined).toHaveLength(1);
    expect(declined[0]?.data?.rule).toBe("declined");
    expect(declined[0]?.data?.layer).toBe("network");
    expect(declined[0]?.data?.matched).toBeGreaterThan(0);
    // Not the other diagnosis: the pattern did its job.
    expect(warnings.some((w) => w.event === "fault_rule_unmatched")).toBe(false);
  }, 120_000);

  it("says nothing about a fault that fired", async () => {
    const logFile = join(logDir, "fired.jsonl");
    const warnings = await warningsFrom(
      logFile,
      new ChaosCrawler({
        baseUrl: base,
        maxPages: 1,
        maxActionsPerPage: 0,
        headless: true,
        timeout: 5000,
        logFile,
        logLevel: "warn",
        faultInjection: [
          faults.status(503, { urlPattern: /127\.0\.0\.1/, name: "lands", probability: 1 }),
        ],
      }),
    );

    expect(warnings.filter((w) => String(w.event).startsWith("fault_rule_"))).toEqual([]);
  }, 120_000);
});
