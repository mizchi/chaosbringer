import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScan } from "./run.js";
import type { ScanReportFile } from "./run.js";

/**
 * `runScan` end to end on a small site with one bug of each kind the scan's
 * phases are for: a broken link (clean crawl, bugs), a list that renders an
 * API response with no failure path (chaos crawl, resilience), and a button
 * that thrashes layout (clean crawl, perf).
 */
describe("runScan", () => {
  let server: http.Server;
  let base: string;
  let outDir: string;

  const page = (body: string) => `<!doctype html><title>t</title><body>${body}</body>`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/api/items") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: ["a", "b", "c"] }));
        return;
      }
      const html: Record<string, string> = {
        // /docs/ exists and /docs does not, as on many servers: the link must
        // be followed as written, not with its trailing slash stripped.
        "/": page(`<a href="/list">list</a> <a href="/thrash">thrash</a> <a href="/missing">missing</a> <a href="/docs/">docs</a>`),
        "/docs/": page("<p>docs</p>"),
        // No catch, no response.ok check: a 500's JSON has no `items`.
        "/list": page(`<ul id="l"></ul><script>
          fetch("/api/items").then((r) => r.json()).then((d) => {
            document.getElementById("l").innerHTML = d.items.map((i) => "<li>" + i + "</li>").join("");
          });
        </script>`),
        "/thrash": page(`<div id="rows"></div><button id="grow">Grow rows</button><script>
          const rows = document.getElementById("rows");
          for (let i = 0; i < 100; i++) rows.appendChild(document.createElement("div")).textContent = "row " + i;
          document.getElementById("grow").addEventListener("click", () => {
            for (const r of rows.children) r.style.height = (r.offsetHeight + 1) + "px";
          });
        </script>`),
      };
      res.writeHead(html[path] ? 200 : 404, { "content-type": "text/html" });
      res.end(html[path] ?? "not found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outDir = mkdtempSync(join(tmpdir(), "chaosbringer-scan-"));
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(outDir, { recursive: true, force: true });
  });

  it("finds the broken link, the missing failure path and the layout thrash", async () => {
    const result = await runScan({
      url: `${base}/`,
      maxPages: 5,
      maxActionsPerPage: 4,
      seed: 7,
      outDir,
      coverage: false,
      hangReleaseMs: 1500,
      crawler: { headless: true, actionWeights: { click: 10, scroll: 0, hover: 0, input: 0, navigate: 0 } },
    });

    expect(result.endpoints.map((e) => e.label)).toEqual([`${base}/api/items`]);
    expect(result.chaos.map((r) => r.fault)).toEqual(["status", "abort", "hang"]);
    const byRule = new Map(result.analysis.findings.map((f) => [f.rule, f]));

    expect(byRule.get("broken-link")?.where).toEqual([`${base}/missing`]);

    const fragile = result.analysis.findings.filter((f) => f.rule === "fault-new-error");
    expect(fragile.length).toBeGreaterThan(0);
    expect(fragile.every((f) => f.category === "resilience")).toBe(true);
    expect(fragile.some((f) => f.where.includes(`${base}/list`))).toBe(true);
    // The clean crawl renders the list without an error.
    expect(result.analysis.findings.some((f) => f.category === "bug" && f.where.includes(`${base}/list`))).toBe(false);

    // /list waits for its fetch with no deadline: the hang crawl's load ran until the release.
    expect(byRule.get("no-request-timeout")?.where).toContain("/list :: load");

    expect(byRule.get("span-layout")?.where).toContain('/thrash :: click button:has-text("Grow rows")');
    // The 404 is reported once, as the broken link, not again as its console echo.
    expect(byRule.has("console-error")).toBe(false);

    const file = JSON.parse(readFileSync(result.files.json, "utf-8")) as ScanReportFile;
    expect(file.findings).toHaveLength(result.analysis.findings.length);
    const md = readFileSync(result.files.markdown, "utf-8");
    expect(md).toContain(`# chaosbringer scan: ${base}/`);
    expect(md).toContain("layout-thrash");
  }, 180_000);
});
