/**
 * The main CLI's output when its stdout is not a terminal — a pipe, as in a
 * CI log or a script — over a real crawl of a three-page site.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Async, not spawnSync: the test server answers from this process's event loop. */
function cli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 90_000, env },
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

  it("--quiet says why a run failed in one line, and nothing more of the report", async () => {
    const output = join(dir, "quiet-reject.json");
    const r = await cli([
      ...["--url", `${server.url}/reject`, "--max-pages", "1", "--max-actions", "0", "--seed", "1"],
      ...[...IGNORE_TSX_NAME, "--strict", "--quiet", "--output", output],
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[FAIL\] 1 pages, 1 errors, [\d.]+s \(seed=1\)$/),
      "  Failed: --strict: 1 unhandled rejection",
      `Report saved to: ${output}`,
    ]);
  }, 120_000);

  // The bundles, the trace and the log are what reproduce a failure, and
  // --quiet (like the full report) named none of them.
  it("--quiet names the failure bundles, the trace and the log it wrote", async () => {
    const output = join(dir, "quiet-paths.json");
    const bundles = join(dir, "bundles");
    const trace = join(dir, "quiet.trace.jsonl");
    const log = join(dir, "quiet.log");
    const r = await cli(
      ["--url", `${server.url}/reject`, "--max-pages", "1", "--max-actions", "0", "--seed", "1"].concat(
        IGNORE_TSX_NAME,
        ["--strict", "--quiet", "--output", output],
        ["--failure-artifacts", bundles, "--trace-out", trace, "--log-file", log],
      ),
    );
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[FAIL\] 1 pages, 1 errors, [\d.]+s \(seed=1\)$/),
      "  Failed: --strict: 1 unhandled rejection",
      `Wrote 1 failure bundle(s) to ${bundles}/`,
      `Trace saved to: ${trace}`,
      `Log saved to: ${log}`,
      `Report saved to: ${output}`,
    ]);
    expect(readdirSync(bundles)).toHaveLength(1);
    expect(existsSync(trace) && existsSync(log)).toBe(true);
  }, 120_000);

  /** `shard`'s workers in a TMPDIR of their own, so a leaked chaos-shard-* is this run's. */
  function shardEnv(): { env: NodeJS.ProcessEnv; leaked: () => string[] } {
    const tmp = mkdtempSync(join(dir, "tmp-"));
    return {
      env: { ...process.env, TMPDIR: tmp },
      leaked: () => readdirSync(tmp).filter((name) => name.startsWith("chaos-shard-")),
    };
  }

  it("shard --quiet prints the merged verdict and its path, and a Repro line for the whole run", async () => {
    const output = join(dir, "shard-quiet.json");
    const { env, leaked } = shardEnv();
    // No --seed: the coordinator draws one for every worker.
    const unseeded = crawl.filter((_, i) => crawl[i] !== "--seed" && crawl[i - 1] !== "--seed");
    const r = await cli(["shard", "--count", "2", ...unseeded, "--quiet", "--output", output], env);
    expect(r.status).toBe(0);
    // It printed the whole merged report, 80-odd lines.
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[PASS\] 3 pages, 0 errors, [\d.]+s \(seed=\d+\)$/),
      `Merged report saved to: ${output}`,
    ]);
    // A process.exit inside the try skipped the finally that removes it.
    expect(leaked()).toEqual([]);
    const merged = JSON.parse(readFileSync(output, "utf8")) as { seed: number; reproCommand: string };
    // It was shard 0's line, which reran shard 0 alone.
    expect(merged.reproCommand).toMatch(
      new RegExp(`^chaosbringer shard --count 2 --url ${escapeRegExp(server.url)}/ --seed ${merged.seed} `),
    );
    expect(merged.reproCommand).not.toContain("--shard");
  }, 180_000);

  it("shard --compact prints the merged compact report, not each worker's", async () => {
    const { env, leaked } = shardEnv();
    const r = await cli(["shard", "--count", "2", ...crawl, "--compact", "--output", join(dir, "shard-compact.json")], env);
    expect(r.status).toBe(0);
    expect(leaked()).toEqual([]);
    expect(r.stdout.match(/^\[PASS\] /gm)).toEqual(["[PASS] "]);
    expect(r.stdout).toMatch(/^\[PASS\] 3 pages, 0 errors, [\d.]+s \(seed=1\)$/m);
    expect(r.stdout).not.toContain("Progress:");
  }, 180_000);

  it("shard removes its temp dir when no worker wrote a report", async () => {
    const { env, leaked } = shardEnv();
    // Every worker refuses the file (exit 2) before a browser starts.
    const r = await cli(["shard", "--count", "2", ...crawl, "--perf-budgets", join(dir, "missing.json")], env);
    expect(r.stderr).toContain("shard: no reports produced");
    expect(r.status).toBe(1);
    expect(leaked()).toEqual([]);
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
