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
      if (req.url === "/reject") {
        res.end(`<!doctype html><title>reject</title><script>Promise.reject(new Error("boom"))</script>`);
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

  it("--quiet prints the verdict line and the paths written, nothing else", async () => {
    const output = join(dir, "quiet.json");
    const junit = join(dir, "quiet.xml");
    const r = await cli([...crawl, "--quiet", "--output", output, "--junit", junit]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[PASS\] 3 pages, 0 errors, [\d.]+s \(seed=1\)$/),
      `Report saved to: ${output}`,
      `JUnit XML saved to: ${junit}`,
    ]);
  }, 120_000);

  it("--strict --compact says why a run whose only finding is a rejection failed", async () => {
    const r = await cli([
      ...["--url", `${server.url}/reject`, "--max-pages", "1", "--max-actions", "0", "--seed", "1"],
      ...[...IGNORE_TSX_NAME, "--strict", "--compact", "--output", join(dir, "reject.json")],
    ]);
    expect(r.status).toBe(1);
    // It printed `[FAIL] 1 pages, 0 errors` and nothing else about the run.
    expect(r.stdout).toMatch(/^\[FAIL\] 1 pages, 1 errors, /m);
    expect(r.stdout).toContain("\n  Failed: --strict: 1 unhandled rejection\n");
    expect(r.stdout).toContain("\n    [unhandled-rejection] boom\n");
    expect(r.stdout).toMatch(/^ {2}Repro: chaosbringer --url \S+\/reject .*--strict/m);
  }, 120_000);
});
