/**
 * `chaosbringer flake` end to end, on the repo's fixture site: the main
 * crawl's flags reach every run's crawler (it refused them as unknown
 * options, exit 2), each before a `--` and as a pasted crawl command after
 * one, and each run is judged by the crawl's own exit rules.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/site/server.js";
import type { FlakeAnalysis } from "./flake.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { TraceEntry, TraceMeta } from "./trace.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Async, not spawnSync: the test servers answer from this process's event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: PACKAGE_DIR, timeout: 120_000 },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

const entries = (path: string): TraceEntry[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEntry);
const visits = (path: string) => entries(path).flatMap((e) => (e.kind === "visit" ? [new URL(e.url).pathname] : []));
const analysis = (path: string) => JSON.parse(readFileSync(path, "utf8")) as FlakeAnalysis;

describe("chaosbringer flake with the main crawl's flags", () => {
  let site: { url: string; close: () => Promise<void> };
  let dir: string;

  beforeAll(async () => {
    site = await startFixtureServer(0);
    dir = mkdtempSync(join(tmpdir(), "chaos-flake-e2e-"));
  });

  afterAll(async () => {
    await site?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards --strict, --exclude, --settle and --ignore-preset to every run", async () => {
    const out = join(dir, "forward.json");
    const trace = join(dir, "forward.jsonl");
    // Without actions the crawl visits the home page's links in order, the
    // two excluded among the first.
    const r = await cli([
      "flake", "--url", `${site.url}/`, "--runs", "2", "--max-pages", "3", "--max-actions", "0", "--seed", "1",
      "--strict", "--exclude", "/about", "--exclude", "/broken-link", "--settle", "adaptive",
      "--ignore-preset", "analytics", "--trace-out", trace, "--output", out,
    ]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    for (const run of [1, 2]) {
      const path = join(dir, `forward.run${run}.jsonl`);
      const visited = visits(path);
      expect(visited).toHaveLength(3);
      expect(visited).toContain("/console-error");
      expect(visited).not.toContain("/about");
      expect(visited).not.toContain("/broken-link");
      // The setup the run crawled with, as its trace records it.
      expect((entries(path)[0] as TraceMeta).setup).toMatchObject({
        settle: "adaptive",
        excludePatterns: ["/about", "/broken-link"],
        ignoreErrorPatterns: expect.arrayContaining(["googletagmanager\\.com"]),
      });
    }
    // --strict fails both runs alike on the console error and the exception.
    const a = analysis(out);
    expect(a.verdicts.map((v) => [v.seed, v.passed])).toEqual([[1, false], [1, false]]);
    expect(a.verdicts[0]!.reasons).toEqual([expect.stringMatching(/^--strict: 1 console error/)]);
    expect(a.verdictFlaky).toBe(false);
    expect(r.stdout).toContain("Verdicts (the crawl's exit rules): every run failed");
  }, 180_000);

  it("runs a pasted crawl command after --", async () => {
    const out = join(dir, "pasted.json");
    const trace = join(dir, "pasted.jsonl");
    const r = await cli([
      "flake", "--runs", "2", "--output", out, "--",
      "chaosbringer", "--url", `${site.url}/`, "--seed", "9", "--exclude", "/about", "--exclude", "/broken-link",
      "--exclude", "/console-error", "--max-pages", "2", "--max-actions", "0", "--trace-out", trace,
      "--bind", "--bind-title", "cb-flake-e2e",
    ]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    // Each run's bound browser says how to attach to it, as the crawl's does.
    expect(r.stdout.match(/npx playwright cli attach cb-flake-e2e/g)).toHaveLength(2);
    expect(analysis(out).verdicts.map((v) => v.seed)).toEqual([9, 9]);
    for (const run of [1, 2]) {
      const visited = visits(join(dir, `pasted.run${run}.jsonl`));
      expect(visited).toHaveLength(2);
      for (const excluded of ["/about", "/broken-link", "/console-error"]) expect(visited).not.toContain(excluded);
    }
  }, 180_000);
});

describe("chaosbringer flake --invariants", () => {
  let server: TestServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-flake-inv-e2e-"));
    // A tame marker, the one the xss-marker invariant looks for.
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><p>hi</p><script>window.__cb_xss_fired = 1</script>`);
    });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("checks the invariants in every run, and fails each run on a violation", async () => {
    const out = join(dir, "inv.json");
    // A baseline with no clusters: each run is diffed against it, as the
    // crawl diffs itself, so --baseline-strict judges every run too.
    const baseline = join(dir, "baseline.json");
    writeFileSync(baseline, JSON.stringify({ baseUrl: `${server.url}/`, errorClusters: [], pages: [] }));
    const r = await cli([
      "flake", "--url", `${server.url}/`, "--runs", "2", "--max-pages", "1", "--max-actions", "0",
      "--invariants", "xss-marker", "--baseline", baseline, "--baseline-strict", "--output", out,
    ]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const a = analysis(out);
    expect(a.verdicts.every((v) => !v.passed && v.reasons.some((x) => /invariant violation/.test(x)))).toBe(true);
    for (const v of a.verdicts) expect(v.reasons).toContainEqual(expect.stringMatching(/^--baseline-strict: 1 new cluster/));
    expect(a.stableClusters.map((c) => c.type)).toContain("invariant-violation");
    // Without it, both pass.
    const clean = join(dir, "clean.json");
    const c = await cli(["flake", "--url", `${server.url}/`, "--runs", "2", "--max-pages", "1", "--max-actions", "0", "--output", clean]);
    expect(c.status, c.stderr).toBe(0);
    expect(analysis(clean).verdicts.every((v) => v.passed)).toBe(true);
    // Without --seed, each run draws its own.
    expect(new Set(analysis(clean).verdicts.map((v) => v.seed)).size).toBe(2);
  }, 180_000);
});
