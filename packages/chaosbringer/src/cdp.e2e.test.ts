import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

describe("crawl through an existing CDP browser", () => {
  let server: http.Server;
  let browser: Browser;
  let baseUrl: string;
  let cdpEndpoint: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/one" ? '<a href="/two">next</a>' : "<p>done</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    cdpEndpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`${cdpEndpoint}/json/version`).then((res) => res.ok).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("CDP endpoint did not start");
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("reuses the selected tab for every URL and leaves the browser running", async () => {
    const context = await browser.newContext();
    const target = await context.newPage();
    const other = await context.newPage();
    await target.goto(`${baseUrl}/one`);
    await other.goto(`${baseUrl}/other`);
    const session = await context.newCDPSession(target);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();

    const crawler = new ChaosCrawler({
      baseUrl: `${baseUrl}/one`,
      cdpEndpoint,
      cdpTargetId: targetInfo.targetId,
      maxPages: 2,
      maxActionsPerPage: 0,
    });
    const report = await crawler.start();

    expect(report.pagesVisited).toBe(2);
    expect(report.reproCommand).toContain(`--cdp ${cdpEndpoint}`);
    expect(report.reproCommand).toContain(`--cdp-target ${targetInfo.targetId}`);
    expect(target.isClosed()).toBe(false);
    expect(target.url()).toBe(`${baseUrl}/two`);
    expect(other.url()).toBe(`${baseUrl}/other`);
    expect(browser.isConnected()).toBe(true);

    const output = join(mkdtempSync(join(tmpdir(), "chaos-cdp-")), "report.json");
    await promisify(execFile)("pnpm", [
      "exec", "tsx", "src/cli.ts", "--url", `${baseUrl}/one`,
      "--cdp", new URL(cdpEndpoint).port, "--cdp-target", targetInfo.targetId,
      "--max-pages", "1", "--max-actions", "0", "--output", output, "--quiet",
    ], { cwd: process.cwd(), timeout: 30_000 });
    const cliReport = JSON.parse(readFileSync(output, "utf8")) as { pagesVisited: number };
    expect(cliReport.pagesVisited).toBe(1);
    expect(target.isClosed()).toBe(false);
    expect(browser.isConnected()).toBe(true);

    const commandDir = mkdtempSync(join(tmpdir(), "chaos-terminal-browser-"));
    const command = join(commandDir, "terminal-browser");
    const listing = { browsers: [{ cdpPort: Number(new URL(cdpEndpoint).port), tabs: [
      { url: `${baseUrl}/one`, targetId: targetInfo.targetId, active: true },
      { url: `${baseUrl}/other`, targetId: "other", active: false },
    ] }] };
    writeFileSync(command, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(listing))})\n`);
    chmodSync(command, 0o755);
    const autoOutput = join(commandDir, "report.json");
    await promisify(execFile)("pnpm", [
      "exec", "tsx", "src/cli.ts", "--url", `${baseUrl}/one`,
      "--terminal-browser", "--max-pages", "1", "--max-actions", "0",
      "--output", autoOutput, "--quiet",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${commandDir}${delimiter}${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });
    const autoReport = JSON.parse(readFileSync(autoOutput, "utf8")) as { pagesVisited: number; reproCommand: string };
    expect(autoReport.pagesVisited).toBe(1);
    expect(autoReport.reproCommand).toContain("--terminal-browser");
    expect(target.isClosed()).toBe(false);
    expect(browser.isConnected()).toBe(true);

    await target.goto(baseUrl);
    const autoSelected = await new ChaosCrawler({
      baseUrl,
      cdpEndpoint,
      maxPages: 1,
      maxActionsPerPage: 0,
    }).start();
    expect(autoSelected.pagesVisited).toBe(1);

    await expect(new ChaosCrawler({
      baseUrl,
      cdpEndpoint,
      cdpTargetId: "missing-target",
      maxPages: 1,
    }).start()).rejects.toThrow(/missing-target/);
    expect(browser.isConnected()).toBe(true);
  }, 60_000);
});
