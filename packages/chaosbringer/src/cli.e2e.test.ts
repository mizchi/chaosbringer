/**
 * The main CLI's output when its stdout is not a terminal — a pipe, as in a
 * CI log or a script — over a real crawl of a three-page site, and what a run
 * of `src/` through tsx (as `pnpm crawl` runs it) finds on the fixture site.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/site/server.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlReport } from "./types.js";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const CLI = join(import.meta.dirname, "cli.ts");

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
      "--url", `${server.url}/`, "--seed-from-sitemap", sitemap, "--max-pages", "3", "--max-actions", "0",
      "--seed", "1",
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
    const bundles = join(dir, "no-bundles");
    // No page failed, so no bundle: it printed `Wrote 0 failure bundle(s) to`
    // a directory it never made.
    const r = await cli([...crawl, "--quiet", "--output", output, "--junit", junit, "--failure-artifacts", bundles]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[PASS\] 3 pages, 0 errors, [\d.]+s \(seed=1\)$/),
      `Report saved to: ${output}`,
      `JUnit XML saved to: ${junit}`,
    ]);
    expect(existsSync(bundles)).toBe(false);
  }, 120_000);

  it("--quiet says why a run failed in one line, and nothing more of the report", async () => {
    const output = join(dir, "quiet-reject.json");
    const r = await cli([
      "--url", `${server.url}/reject`, "--max-pages", "1", "--max-actions", "0", "--seed", "1",
      "--strict", "--quiet", "--output", output,
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
        ["--strict", "--quiet", "--output", output],
        // A trailing slash read `…/bundles//`.
        ["--failure-artifacts", `${bundles}/`, "--trace-out", trace, "--log-file", log],
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

  // The workers' output is silenced, and theirs were the only lines naming
  // the bundles and the log, which --quiet promises.
  it("shard --quiet names the bundles and the log its workers wrote", async () => {
    const output = join(dir, "shard-paths.json");
    const bundles = join(dir, "shard-bundles");
    const log = join(dir, "shard.log");
    // The rejecting page is not the base URL, which every shard crawls, so
    // one worker writes its bundle.
    const sitemap = join(dir, "reject-sitemap.xml");
    const locs = ["/", "/reject"].map((p) => `<url><loc>${server.url}${p}</loc></url>`).join("");
    writeFileSync(sitemap, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    const { env, leaked } = shardEnv();
    const r = await cli(
      ["shard", "--count", "2", "--url", `${server.url}/`, "--seed-from-sitemap", sitemap].concat(
        ["--max-pages", "2", "--max-actions", "0", "--seed", "1", "--strict", "--quiet", "--output", output],
        ["--failure-artifacts", bundles, "--log-file", log],
      ),
      env,
    );
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[FAIL\] \d+ pages, 1 errors, [\d.]+s \(seed=1\)$/),
      "  Failed: --strict: 1 unhandled rejection",
      `Wrote 1 failure bundle(s) to ${bundles}/`,
      `Log saved to: ${log}`,
      `Merged report saved to: ${output}`,
      "1/2 shard(s) exited non-zero",
    ]);
    expect(readdirSync(bundles)).toHaveLength(1);
    expect(existsSync(log)).toBe(true);
    expect(leaked()).toEqual([]);
  }, 180_000);

  // Every worker wrote these to the same paths: the JUnit file held one
  // shard's pages, and the cluster count summed the shards that bundled the
  // base URL's cluster, which has one directory.
  it("shard writes --junit, --heatmap-out and the cluster bundles from the merged report", async () => {
    const output = join(dir, "shard-files.json");
    const bundles = join(dir, "shard-cluster-bundles");
    const junit = join(dir, "shard.xml");
    const heatmap = join(dir, "shard-heatmap.json");
    // The rejecting page is the base URL, which every shard crawls.
    const sitemap = join(dir, "reject-base-sitemap.xml");
    const locs = ["/reject", "/", "/a", "/b"].map((p) => `<url><loc>${server.url}${p}</loc></url>`).join("");
    writeFileSync(sitemap, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    const { env, leaked } = shardEnv();
    const r = await cli(
      ["shard", "--count", "2", "--url", `${server.url}/reject`, "--seed-from-sitemap", sitemap].concat(
        ["--max-pages", "4", "--max-actions", "0", "--seed", "1", "--strict", "--quiet", "--output", output],
        ["--failure-artifacts", bundles, "--cluster-artifacts", "--junit", junit, "--heatmap-out", heatmap],
      ),
      env,
    );
    expect(r.status).toBe(1);
    const merged = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(merged.pages).toHaveLength(4);
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[FAIL\] 4 pages, 1 errors, [\d.]+s \(seed=1\)$/),
      "  Failed: --strict: 1 unhandled rejection",
      `Heatmap saved to: ${heatmap}`,
      expect.stringMatching(new RegExp(`^Wrote \\d failure bundle\\(s\\) to ${escapeRegExp(bundles)}/$`)),
      `Wrote 1 cluster bundle(s) to ${bundles}/clusters/`,
      `Merged report saved to: ${output}`,
      `JUnit XML saved to: ${junit}`,
      "2/2 shard(s) exited non-zero",
    ]);
    expect(readdirSync(join(bundles, "clusters"))).toHaveLength(merged.errorClusters.length);
    expect(readFileSync(junit, "utf8")).toContain(`tests="4"`);
    expect(JSON.parse(readFileSync(heatmap, "utf8"))).toEqual([]);
    expect(leaked()).toEqual([]);
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
    // Every worker fails to connect to the browser it is told to attach to,
    // which the coordinator cannot check for them.
    const closed = await startTestServer(() => {});
    await closed.close();
    const r = await cli(["shard", "--count", "2", ...crawl, "--cdp", closed.url], env);
    expect(r.stderr).toContain("shard: no reports produced");
    expect(r.status).toBe(1);
    expect(leaked()).toEqual([]);
  }, 120_000);

  it("--strict --compact says why a run whose only finding is a rejection failed", async () => {
    const r = await cli([
      "--url", `${server.url}/reject`, "--max-pages", "1", "--max-actions", "0", "--seed", "1",
      "--strict", "--compact", "--output", join(dir, "reject.json"),
    ]);
    expect(r.status).toBe(1);
    // It printed `[FAIL] 1 pages, 0 errors` and nothing else about the run.
    expect(r.stdout).toMatch(/^\[FAIL\] 1 pages, 1 errors, /m);
    expect(r.stdout).toContain("\n  Failed: --strict: 1 unhandled rejection\n");
    expect(r.stdout).toContain("\n    [unhandled-rejection] boom\n");
    expect(r.stdout).toMatch(/^ {2}Repro: chaosbringer --url \S+\/reject .*--strict/m);
  }, 120_000);
});

describe("HTTP status and dead-link rules", () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-http-"));
    server = await startTestServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<!doctype html><title>home</title><img src="/missing.png" alt=""><a href="/gone">gone</a>` +
            `<script>fetch("/api/broken").catch(() => {})</script>`,
        );
        return;
      }
      res.writeHead(req.url === "/api/broken" ? 500 : 404, { "content-type": "text/plain" });
      res.end("no");
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const crawl = () => ["--url", `${server.url}/`, "--max-pages", "2", "--max-actions", "0", "--seed", "1"];

  it("passes without a rule, and still names the dead link in --compact", async () => {
    const r = await cli([...crawl(), "--compact", "--output", join(dir, "pass.json")]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^\[PASS\] 2 pages, /));
    expect(lines).toContain(`  Dead links: 1 (first: ${server.url}/gone <- ${server.url}/)`);
  }, 120_000);

  it("--fail-on-http 5xx and --fail-on-dead-links fail with exit 1, name the first of each, and annotate them as errors", async () => {
    const output = join(dir, "fail.json");
    const r = await cli([...crawl(), "--fail-on-http", "5xx", "--fail-on-dead-links", "--quiet", "--github-annotations", "--output", output]);
    expect(r.status).toBe(1);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 3)).toEqual([
      expect.stringMatching(/^\[FAIL\] 2 pages, \d+ errors, /),
      `  Dead links: 1 (first: ${server.url}/gone <- ${server.url}/)`,
      `  Failed: --fail-on-http 5xx: 1 HTTP response >= 500 (first: GET ${server.url}/api/broken 500 on ${server.url}/); ` +
        `--fail-on-dead-links: 1 dead link (first: ${server.url}/gone <- ${server.url}/)`,
    ]);
    const annotations = lines.filter((l) => l.startsWith("::"));
    expect(annotations).toContainEqual(expect.stringMatching(/^::error title=\[console\] Failed to load resource%3A .*Internal Server Error/));
    // The 404s (the image, and the dead link's own line) fail no rule of this run.
    expect(annotations).toContainEqual(expect.stringMatching(/^::warning title=\[console\] ×2 Failed to load resource%3A .*Not Found/));
    expect(annotations).toContainEqual(expect.stringMatching(/^::error title=Dead link%3A /));
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.reproCommand).toMatch(/ --fail-on-http 5xx --fail-on-dead-links$/);
  }, 120_000);
});

// A sitemap that 404s and a baseline that is not there: the run passed in
// silence, and --log-console printed nothing without --log-file.
describe("warnings on the CLI", () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-warn-"));
    server = await startTestServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>home</title><p>home</p>`);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const crawl = () => [
    "--url", `${server.url}/`, "--max-pages", "1", "--max-actions", "0", "--seed", "1",
    "--seed-from-sitemap", `${server.url}/sitemap.xml`, "--baseline", join(dir, "no-baseline.json"),
  ];

  it("passes, names them in --quiet and as ::warning annotations, and --log-console alone logs to stderr", async () => {
    const output = join(dir, "quiet.json");
    const r = await cli([...crawl(), "--quiet", "--github-annotations", "--log-console", "--output", output]);
    expect(r.status).toBe(0);
    const sitemap = `sitemap ${server.url}/sitemap.xml could not be read (sitemap fetch ${server.url}/sitemap.xml failed: HTTP 404), ` +
      "so the crawl started from the base URL alone";
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^\[PASS\] 1 pages, 0 errors, /),
      `  Warnings: 2 (first: ${sitemap})`,
      `::warning title=chaosbringer warning%3A sitemap-unreadable::${sitemap}`,
      expect.stringMatching(/^::warning title=chaosbringer warning%3A baseline-missing::baseline .*no-baseline\.json not found, so no diff was made/),
      `Report saved to: ${output}`,
    ]);
    // The logger's own line, which needed --log-file to go anywhere.
    const logged = r.stderr.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { level: string; event: string });
    expect(logged).toContainEqual(expect.objectContaining({ level: "warn", event: "sitemap_fetch_failed" }));
    // From warn up, by default: no info lines.
    expect(logged.every((e) => e.level === "warn" || e.level === "error")).toBe(true);
    expect(r.stderr).not.toContain("Baseline not found");
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.warnings?.map((w) => w.code)).toEqual(["sitemap-unreadable", "baseline-missing"]);
  }, 120_000);

  it("--fail-on-warnings fails with exit 1 and names the first; the repro keeps the flag", async () => {
    const output = join(dir, "fail.json");
    const r = await cli([...crawl(), "--compact", "--fail-on-warnings", "--output", output]);
    expect(r.status).toBe(1);
    const lines = r.stdout.split("\n");
    expect(lines).toContainEqual(expect.stringMatching(/^\[FAIL\] 1 pages, 0 errors, /));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^  Failed: --fail-on-warnings: 2 warnings \\(first: ${escapeRegExp(`sitemap ${server.url}/sitemap.xml could not be read`)}`)));
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.reproCommand).toMatch(/ --fail-on-warnings$/);
    expect(lines).toContain(`  Repro: ${report.reproCommand}`);
  }, 120_000);
});

describe("a page whose connection the server drops", () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-drop-"));
    server = await startTestServer((req, res) => {
      // No response at all: `page.goto` rejects with ERR_EMPTY_RESPONSE.
      if (req.url === "/reset" || req.url === "/reset2") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>home</title><a href="/reset">r</a> <a href="/reset2">r2</a>`);
    });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The cluster key kept Playwright's call log, which names the `waitUntil`
  // --settle picks, and its ANSI colours: the same failure was a new cluster
  // and a resolved one under another --settle, and --baseline-strict failed
  // on it. And the failed goto counted as a JS exception the site never threw.
  it("is the same cluster under another --settle, and not a JS exception under --strict", async () => {
    const crawl = ["--url", `${server.url}/`, "--max-pages", "3", "--max-actions", "0", "--seed", "1", "--quiet"];
    const first = join(dir, "r1.json");
    const r1 = await cli([...crawl, "--output", first]);
    expect(r1.status).toBe(1);
    const report = JSON.parse(readFileSync(first, "utf8")) as CrawlReport;
    expect(report.errorClusters.map((c) => [c.key, c.count])).toEqual([
      ["navigation|page.goto: net::ERR_EMPTY_RESPONSE at <url>", 2],
    ]);
    const failure = report.pages.find((p) => p.url.endsWith("/reset"))!.errors;
    expect(failure.map((e) => [e.type, e.message])).toEqual([
      ["navigation", `page.goto: net::ERR_EMPTY_RESPONSE at ${server.url}/reset`],
    ]);
    expect(report.summary.jsExceptions).toBe(0);

    const second = join(dir, "r2.json");
    const r2 = await cli([...crawl, "--settle", "adaptive", "--baseline", first, "--baseline-strict", "--strict", "--output", second]);
    expect(r2.status).toBe(1);
    const failed = r2.stdout.split("\n").find((l) => l.startsWith("  Failed: "));
    expect(failed).toBe(`  Failed: 2 pages failed to load (first: ${server.url}/reset)`);
    expect(r2.stdout).toMatch(/ diff=\+0c\/\+0p\n/);
    const diff = (JSON.parse(readFileSync(second, "utf8")) as CrawlReport).diff!;
    expect([diff.newClusters.length, diff.resolvedClusters.length]).toEqual([0, 0]);
  }, 120_000);

  // Under the offline profile every navigation fails as
  // ERR_INTERNET_DISCONNECTED, which is on `load`'s list: a running server
  // was refused as "is the server running?", with no report.
  it("under --network offline is the run's own doing: reported, not refused", async () => {
    const output = join(dir, "offline.json");
    const r = await cli(["--url", `${server.url}/`, "--max-pages", "1", "--max-actions", "0", "--network", "offline", "--quiet", "--output", output]);
    expect(r.stderr).not.toContain("could not reach");
    expect(r.status).toBe(1);
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.pages[0]!.errors[0]!.message).toContain("net::ERR_INTERNET_DISCONNECTED");
  }, 120_000);
});

describe("a target nothing listens on", () => {
  let dir: string;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-down-"));
    const closed = await startTestServer(() => {});
    await closed.close();
    url = `${closed.url}/`;
  }, 30_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const refusal = (command: string) =>
    `${command}: could not reach ${url}: is the server running? (net::ERR_CONNECTION_REFUSED at ${url})`;

  it("crawl refuses in one stderr line with exit 2, and writes no report", async () => {
    const output = join(dir, "down.json");
    const junit = join(dir, "down.xml");
    const r = await cli(["--url", url, "--max-pages", "1", "--max-actions", "0", "--quiet", "--output", output, "--junit", junit]);
    expect(r.status).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toEqual([refusal("chaosbringer")]);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(junit)).toBe(false);
  }, 120_000);

  // The goto error names the URL navigated to, not the host that failed:
  // a running site whose start URL redirects to a host that is down (an SSO
  // that is not up yet) was refused as unreachable, with no report. The host
  // is another origin (another port), so it is an off-site redirect, not a
  // failed load of the start URL; `noOffsiteRedirect` is what fails it.
  it("crawl reports a start URL that redirects to a host that is down, not refuses it", async () => {
    const site = await startTestServer((_req, res) => {
      res.writeHead(302, { location: url });
      res.end();
    });
    try {
      const output = join(dir, "sso.json");
      const r = await cli(["--url", `${site.url}/sso`, "--max-pages", "1", "--max-actions", "0", "--quiet", "--output", output]);
      expect(r.stderr).not.toContain("could not reach");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`  Off-site redirects: 1 (first: ${site.url}/sso -> ${url})`);
      const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
      expect(report.pages[0]).toMatchObject({ status: "success", errors: [], redirectedTo: url });
      expect(report.pages[0]!.offsiteNavigations?.[0]).toMatchObject({ trigger: "server-redirect", failed: "net::ERR_CONNECTION_REFUSED" });
      const checked = await cli([
        "--url", `${site.url}/sso`, "--max-pages", "1", "--max-actions", "0", "--quiet", "--invariants", "no-offsite-redirect",
        "--output", join(dir, "sso-checked.json"),
      ]);
      expect(checked.status).toBe(1);
      expect(checked.stdout).toContain("  Failed: 1 invariant violation");
    } finally {
      await site.close();
    }
  }, 120_000);

  it("shard refuses with exit 2 when every worker did, and merges nothing", async () => {
    const output = join(dir, "shard.json");
    const tmp = mkdtempSync(join(dir, "tmp-"));
    const r = await cli(
      ["shard", "--count", "2", "--url", url, "--max-pages", "1", "--max-actions", "0", "--quiet", "--output", output],
      { ...process.env, TMPDIR: tmp },
    );
    expect(r.status).toBe(2);
    // Each worker's own refusal, on the stderr they inherit; nothing more.
    expect(r.stderr.trimEnd().split("\n")).toEqual([refusal("chaosbringer"), refusal("chaosbringer")]);
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(tmp).filter((name) => name.startsWith("chaos-shard-"))).toEqual([]);
  }, 120_000);

  // flake called the one failure every run met a stable cluster, and exited 0.
  it("flake refuses with exit 2 after the first run, not a stable cluster", async () => {
    const r = await cli(["flake", "--url", url, "--runs", "2", "--max-pages", "1", "--max-actions", "0"]);
    expect(r.status).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toEqual([refusal("chaosbringer flake")]);
    expect(r.stdout).not.toContain("Run 2/2");
    expect(r.stdout).not.toContain("Stable clusters");
  }, 120_000);

  // scan suggested a single-page app, a bot check or a consent wall.
  it("scan refuses with exit 2, without its SPA or bot-check hints", async () => {
    const r = await cli(["scan", "--url", url, "--no-chaos", "--max-pages", "1", "--max-actions", "0", "--quiet", "--out", join(dir, "scan")]);
    expect(r.status).toBe(2);
    expect(r.stderr.trimEnd().split("\n")).toEqual([refusal("chaosbringer scan")]);
    expect(r.stdout).not.toMatch(/single-page app|bot check|consent wall/);
  }, 120_000);
});

describe("a run of src/ through tsx", () => {
  let site: { url: string; close: () => Promise<void> };
  let dir: string;

  beforeAll(async () => {
    site = await startFixtureServer(0);
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-src-"));
  });

  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // tsx compiles with esbuild's keepNames, which wrapped the functions the
  // crawler sends into the page in a `__name` helper the page does not have:
  // the page reported `__name is not defined`, and the SPA hook, the link
  // collector and the action-target scan threw instead of finding anything.
  it("finds what dist/ finds on a clean page: no errors, the SPA route, its buttons", async () => {
    const output = join(dir, "spa-router.json");
    const r = await cli([
      "--url", `${site.url}/spa-router`, "--max-pages", "1", "--max-actions", "3", "--seed", "1",
      "--quiet", "--output", output,
    ]);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.totalErrors).toBe(0);
    expect(report.pages[0]?.errors).toEqual([]);
    // Recorded by the History API hook: the page calls `replaceState` on load.
    expect(report.pages[0]?.links).toContain(`${site.url}/spa-router/auto`);
    // The page has no links, so a click can only be one of its buttons.
    expect(report.actions.some((a) => a.type === "click")).toBe(true);
  }, 120_000);

  // A plan that ran out before --until-url held (here: wrong credentials,
  // which the fixture's /login rejects) was asked for its next step forever,
  // and the run only ended when something killed it.
  it.each([
    ["a plan that never submits", [{ fill: 'textbox "Username"', value: "alice" }], "nowhere", 1],
    [
      "wrong credentials",
      [
        { fill: 'textbox "Username"', value: "alice" },
        { fill: 'textbox "Password"', value: "hunter2" },
        { click: 'button "Sign in"' },
      ],
      "auth-thanks",
      3,
    ],
  ])("drive: %s ends as stuck, exit 1, once the plan ran out", async (name, plan, until, steps) => {
    const file = join(dir, `plan-${name.replace(/\W+/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(plan));
    const started = Date.now();
    const r = await cli(["drive", "--url", `${site.url}/login`, "--goal", "log in", "--plan", file, "--until-url", until, "--quiet"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`drive: stuck — the plan is complete, but the success condition does not hold (the URL contains "${until}")`);
    expect(r.stdout).toContain(`${steps} step(s)`);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
