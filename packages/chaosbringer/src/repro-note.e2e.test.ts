import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { faults } from "./faults.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * A page that throws only when its API answers 500, crawled with that fault
 * set in code. Its report's repro command and its bundle's `repro.sh` used to
 * rerun the crawl without the fault, clean, and say nothing about it.
 */
describe("a run's repro with a fault set in code", () => {
  let server: TestServer;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if ((req.url ?? "").startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"items":[]}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><ul id="l"></ul><script>
        fetch("/api/items").then((r) => r.json()).then((d) => { l.textContent = d.items.length; });
      </script>`);
    });
    base = server.url;
    dir = mkdtempSync(join(tmpdir(), "chaos-repro-note-"));
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names it in the Repro line and in repro.sh", async () => {
    const report = await new ChaosCrawler({
      baseUrl: `${base}/`,
      maxPages: 1,
      maxActionsPerPage: 0,
      seed: 3,
      headless: true,
      faultInjection: [faults.status(500, { urlPattern: "/api/", name: "api-500" })],
      failureArtifacts: { dir, saveScreenshot: false, saveHtml: false },
    }).start();
    expect(report.faultInjections?.[0]?.injected).toBe(1);
    expect(report.reproCommand).toBe(`chaosbringer --url ${base}/ --seed 3 --max-pages 1 --max-actions 0 # + 1 fault rule not expressible on the CLI: api-500`);

    const bundles = readdirSync(dir);
    expect(bundles).toHaveLength(1);
    const script = readFileSync(join(dir, bundles[0] ?? "", "repro.sh"), "utf8");
    expect(script.split("\n")).toContain("# + 1 fault rule not expressible on the CLI: api-500");
    execFileSync("sh", ["-n"], { input: script });
  }, 60_000);
});
