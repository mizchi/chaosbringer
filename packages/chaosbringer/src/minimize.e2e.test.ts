/**
 * `chaosbringer minimize` end to end: a recorded trace, then the CLI's two
 * outcomes the unit tests of `minimizeActions` cannot see — a `--match` that
 * never reproduces (it used to shrink anyway and report success) and a failure
 * on the page load alone (it used to keep an action ddmin could not drop).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const CLI = join(import.meta.dirname, "cli.ts");

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

/**
 * A failure only a logged-in visit has: the page throws when its session
 * cookie is set. `minimize --storage-state` exited 2 as an unknown option,
 * and the trace did not record the login, so a replay ran logged out and
 * the failure "did not reproduce".
 */
describe("chaosbringer minimize with the crawl's setup", () => {
  let server: TestServer;
  let dir: string;
  let trace: string;
  let state: string;
  const COOKIE_VALUE = "cb-cookie-value-not-for-traces";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-minimize-setup-e2e-"));
    server = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>t</title><a href="/">Home</a> <a href="/#a">A</a>
        <div style="height:3000px"></div>
        <script>if (document.cookie.includes("cb_session=")) throw new Error("cb-logged-in-boom")</script>`);
    });
    state = join(dir, "state.json");
    const host = new URL(server.url).hostname;
    writeFileSync(state, JSON.stringify({
      cookies: [{ name: "cb_session", value: COOKIE_VALUE, domain: host, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
      origins: [],
    }));
    writeFileSync(join(dir, "empty-state.json"), JSON.stringify({ cookies: [], origins: [] }));
    trace = join(dir, "run.trace.jsonl");
    const rec = await cli([
      "--url", server.url, "--max-pages", "1", "--max-actions-per-page", "2", "--seed", "1", "--settle", "adaptive",
      "--storage-state", state, "--trace-out", trace, "--output", join(dir, "r.json"), "--quiet",
    ]);
    const report = JSON.parse(readFileSync(join(dir, "r.json"), "utf8")) as { errorClusters: { fingerprint: string }[] };
    expect(report.errorClusters.map((c) => c.fingerprint).join("\n"), rec.stderr).toContain("cb-logged-in-boom");
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the crawl's setup in a v2 trace: the file's path, not its cookies", () => {
    const raw = readFileSync(trace, "utf8");
    expect(JSON.parse(raw.split("\n")[0]!)).toMatchObject({ kind: "meta", v: 2, setup: { settle: "adaptive", storageState: state } });
    expect(raw).not.toContain(COOKIE_VALUE);
  });

  it("replays with the recorded setup, says so, and writes a v2 trace with it", async () => {
    const out = join(dir, "min.jsonl");
    const r = await cli(["minimize", "--trace", trace, "--match", "cb-logged-in-boom", "--trace-out", out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`replaying with the trace's setup: --settle adaptive --storage-state ${state}`);
    expect(JSON.parse(readFileSync(out, "utf8").split("\n")[0]!)).toMatchObject({ v: 2, setup: { storageState: state } });
  }, 120_000);

  it("lets a flag override what was recorded", async () => {
    const r = await cli([
      "minimize", "--trace", trace, "--match", "cb-logged-in-boom", "--storage-state", join(dir, "empty-state.json"),
      "--trace-out", join(dir, "never.jsonl"),
    ]);
    expect(r.stdout).toContain("replaced by the flags given: --storage-state");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the failure did not reproduce");
  }, 120_000);

  it("still minimizes a v1 trace, with the setup given as flags", async () => {
    const v1 = join(dir, "v1.trace.jsonl");
    const [meta, ...rest] = readFileSync(trace, "utf8").split("\n");
    const { setup: _setup, ...plain } = JSON.parse(meta!) as Record<string, unknown>;
    writeFileSync(v1, [JSON.stringify({ ...plain, v: 1 }), ...rest].join("\n"));
    // Without the login, as every v1 replay ran: nothing to minimize.
    const loggedOut = await cli(["minimize", "--trace", v1, "--match", "cb-logged-in-boom", "--trace-out", join(dir, "v1-out.jsonl")]);
    expect(loggedOut.status).toBe(1);
    expect(loggedOut.stdout).toContain("the trace (format v1) records no crawl setup");
    const r = await cli([
      "minimize", "--trace", v1, "--match", "cb-logged-in-boom", "--storage-state", state, "--trace-out", join(dir, "v1-min.jsonl"),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Reduced \d+ → 0 actions over 2 replays/);
  }, 120_000);
});
