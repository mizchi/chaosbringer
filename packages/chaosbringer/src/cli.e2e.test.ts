/**
 * The main CLI's output when its stdout is not a terminal — a pipe, as in a
 * CI log or a script — over a real crawl of a three-page site.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/**
 * tsx compiles `src/` with esbuild's keepNames, so a function the crawler
 * hands to `page.evaluate` calls a `__name` helper the page does not have,
 * and every page reports it as an exception. dist/ (tsc) does not.
 */
const IGNORE_TSX_NAME = ["--ignore-error", "__name is not defined"];

/** Async, not spawnSync: the test server answers from this process's event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 90_000 },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

describe("main CLI output on a pipe", () => {
  let server: TestServer;
  let dir: string;
  /** Without actions the crawl follows no links; a sitemap names the three pages. */
  let crawl: string[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-e2e-"));
    server = await startTestServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/") {
        res.end(`<!doctype html><title>home</title><a href="/a">A</a> <a href="/b">B</a>`);
        return;
      }
      res.end(`<!doctype html><title>${req.url}</title><a href="/">Home</a>`);
    });
    const sitemap = join(dir, "sitemap.xml");
    const locs = ["/", "/a", "/b"].map((p) => `<url><loc>${server.url}${p}</loc></url>`).join("");
    writeFileSync(sitemap, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    crawl = [
      ...["--url", `${server.url}/`, "--seed-from-sitemap", sitemap, "--max-pages", "3", "--max-actions", "0"],
      ...["--seed", "1", ...IGNORE_TSX_NAME],
    ];
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("--compact writes a progress line per page, not a `\\r`-joined run of them", async () => {
    const output = join(dir, "compact.json");
    const r = await cli([...crawl, "--compact", "--output", output]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("\r");
    const lines = r.stdout.split("\n");
    const progress = lines.filter((l) => l.startsWith("Progress:"));
    expect(progress).toEqual(["Progress: 1/3 pages", "Progress: 2/3 pages", "Progress: 3/3 pages"]);
    // The verdict follows the last one directly: no blank line left over
    // from ending a redrawn terminal line.
    expect(lines[lines.indexOf("Progress: 3/3 pages") + 1]).toMatch(/^\[PASS\] 3 pages, 0 errors,/);
  }, 120_000);
});
