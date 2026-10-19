/**
 * `chaosbringer minimize` end to end: a recorded trace, then the CLI's two
 * outcomes the unit tests of `minimizeActions` cannot see — a `--match` that
 * never reproduces (it used to shrink anyway and report success) and a failure
 * on the page load alone (it used to keep an action ddmin could not drop).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Async, not spawnSync: the test server answers from this process's event loop. */
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

const kinds = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { kind: string }).kind);

describe("chaosbringer minimize", () => {
  let server: TestServer;
  let dir: string;
  let trace: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-minimize-e2e-"));
    // The 404 image fails on load, before any action; the links give the
    // crawl actions to record.
    server = await startTestServer((req, res) => {
      if (req.url === "/missing.png") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><img src="/missing.png"><a href="/">Home</a> <a href="/#a">A</a>
        <div style="height:3000px"></div>`);
    });
    trace = join(dir, "run.trace.jsonl");
    const rec = await cli([
      "--url", server.url, "--max-pages", "1", "--max-actions-per-page", "4", "--seed", "1",
      "--trace-out", trace, "--output", join(dir, "r.json"), "--quiet",
    ]);
    expect(existsSync(trace), rec.stderr).toBe(true);
    expect(kinds(trace).filter((k) => k === "action").length).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing and exits 1 when the whole trace does not reproduce the failure", async () => {
    const out = join(dir, "never.jsonl");
    const r = await cli(["minimize", "--url", server.url, "--trace", trace, "--match", "this-never-happens", "--trace-out", out, "--quiet"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("chaosbringer minimize: the failure did not reproduce: a replay of all");
    expect(existsSync(out)).toBe(false);
  }, 120_000);

  it("minimizes a failure on the page load to no actions, keeping the visits", async () => {
    const out = join(dir, "load.jsonl");
    const r = await cli(["minimize", "--url", server.url, "--trace", trace, "--match", "Not Found", "--trace-out", out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Reduced \d+ → 0 actions over 2 replays/);
    const k = kinds(out);
    expect(k).toContain("meta");
    expect(k).toContain("visit");
    expect(k).not.toContain("action");
  }, 120_000);
});
