/**
 * An open redirect from the shell: a `/go?next=` page that sends the browser
 * wherever `next` says, by `location.replace`. `--strict` passes it; the
 * no-offsite-redirect check (alone, or in `--data-safety`) fails it, a trace
 * of the run replays it under `minimize`, and `scan` raises `open-redirect`.
 *
 * The other site is a second local origin (`localhost` beside `127.0.0.1`).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanReportFile } from "./scan/run.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlReport } from "./types.js";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const CLI = join(import.meta.dirname, "cli.ts");

/** Async, not spawnSync: the test servers answer from this process's event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: PACKAGE_DIR, timeout: 90_000 }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ status, stdout, stderr });
    });
  });
}

describe("open redirects on the command line", () => {
  let site: TestServer;
  let other: TestServer;
  let dir: string;
  let go: string;
  let chat: string;
  let off: string;
  const one = ["--max-pages", "1", "--max-actions", "0", "--seed", "1"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-open-redirect-"));
    other = await startTestServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>other</title><p>the other site</p>");
      },
      { host: "localhost" },
    );
    off = other.url;
    site = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/chat") {
        res.writeHead(302, { location: `${off}/invite` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>signing in</title><script>
        location.replace(new URLSearchParams(location.search).get("next") || "/");
      </script>`);
    });
    go = `${site.url}/go?next=${encodeURIComponent(`${off}/phish`)}`;
    chat = `${site.url}/chat`;
  }, 30_000);

  afterAll(async () => {
    await site.close();
    await other.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("--strict passes it, and the compact report names it", async () => {
    const r = await cli(["--url", go, ...one, "--strict", "--compact", "--output", join(dir, "strict.json")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\[PASS\] 1 pages, 0 errors,/m);
    expect(r.stdout).toContain(`  Off-site redirects: 1 (first: ${go} -> ${off}/phish)`);
  }, 120_000);

  it("--data-safety fails it, in the verdict, the annotations, the Repro line and the trace", async () => {
    const output = join(dir, "data-safety.json");
    const trace = join(dir, "run.trace.jsonl");
    const r = await cli([
      "--url", go, ...one, "--data-safety", "--compact", "--github-annotations", "--output", output, "--trace-out", trace,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^\[FAIL\] 1 pages, 1 errors,/m);
    expect(r.stdout).toContain("  Failed: 1 invariant violation");
    expect(r.stdout).toContain("    [invariant-violation] [navigation.no-offsite-redirect] open redirect: <url> -> <url> (script redire...");
    expect(r.stdout).toMatch(/^::error title=\[invariant-violation\] \[navigation.no-offsite-redirect\] open redirect/m);
    // The check's error stands for it: no second annotation.
    expect(r.stdout).not.toMatch(/^::(warning|notice) title=Off-site redirect/m);
    const repro = r.stdout.split("\n").find((l) => l.includes("Repro:")) ?? "";
    expect(repro).toContain(" --invariants data-safety");
    expect(repro).not.toContain("#");
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.pages[0]!.redirectedTo).toBe(`${off}/phish`);
    expect(report.pages[0]!.errors.map((e) => e.invariantName)).toEqual(["navigation.no-offsite-redirect"]);

    // minimize replays the recorded check from the v2 trace.
    expect(JSON.parse(readFileSync(trace, "utf8").split("\n")[0]!)).toMatchObject({ v: 2, setup: { invariants: "data-safety" } });
    const min = await cli(["minimize", "--trace", trace, "--match", "open redirect", "--trace-out", join(dir, "min.jsonl")]);
    expect(min.status, min.stderr).toBe(0);
    expect(min.stdout).toContain("replaying with the trace's setup: --invariants data-safety");
    // Allowing the other origin is what makes it not reproduce.
    const allowed = await cli([
      "minimize", "--trace", trace, "--match", "open redirect", "--offsite-redirect-allow", off, "--trace-out", join(dir, "never.jsonl"),
    ]);
    expect(allowed.status).toBe(1);
    expect(allowed.stderr).toContain("the failure did not reproduce");
  }, 240_000);

  it("--invariants no-offsite-redirect fails a fixed off-site redirect, and --offsite-redirect-allow passes it", async () => {
    const r = await cli(["--url", chat, ...one, "--invariants", "no-offsite-redirect", "--quiet", "--output", join(dir, "chat.json")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`  Off-site redirects: 1 (first: ${chat} -> ${off}/invite)`);
    expect(r.stdout).toContain("  Failed: 1 invariant violation");
    const ok = await cli([
      "--url", chat, ...one, "--invariants", "no-offsite-redirect", "--offsite-redirect-allow", off, "--compact", "--github-annotations",
      "--output", join(dir, "chat-allowed.json"),
    ]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^::notice title=Off-site redirect/m);
    expect(ok.stdout.split("\n").find((l) => l.includes("Repro:")) ?? JSON.parse(readFileSync(join(dir, "chat-allowed.json"), "utf8")).reproCommand).toContain(
      `--invariants no-offsite-redirect --offsite-redirect-allow ${off}`,
    );
  }, 120_000);

  it("refuses an --offsite-redirect-allow that is not an origin, before a browser starts", async () => {
    const r = await cli(["--url", chat, ...one, "--data-safety", "--offsite-redirect-allow", `${off}/login`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is not an origin");
  }, 60_000);

  it("scan raises open-redirect, high when the target is in the URL, and --fail-on gates on it", async () => {
    const out = join(dir, "scan-go");
    const r = await cli(["scan", "--url", go, ...one, "--no-chaos", "--no-coverage", "--fail-on", "high", "--quiet", "--out", out]);
    expect(r.status).toBe(1);
    const file = JSON.parse(readFileSync(join(out, "scan-report.json"), "utf8")) as ScanReportFile;
    expect(file.findings.filter((f) => f.rule === "open-redirect").map((f) => [f.severity, f.category, f.where])).toEqual([
      ["high", "security", [go]],
    ]);
    expect(readFileSync(join(out, "scan-report.md"), "utf8")).toContain("| security | [Open redirect");

    const fixed = join(dir, "scan-chat");
    const low = await cli(["scan", "--url", chat, ...one, "--no-chaos", "--no-coverage", "--fail-on", "high", "--out", fixed]);
    expect(low.status).toBe(0);
    expect(low.stdout).toContain("[security] Off-site redirect: a page sends the browser to another origin on its own");
    const file2 = JSON.parse(readFileSync(join(fixed, "scan-report.json"), "utf8")) as ScanReportFile;
    expect(file2.findings.filter((f) => f.rule === "open-redirect").map((f) => f.severity)).toEqual(["low"]);

    // An SSO-style origin the scan is told about raises nothing, so --fail-on low passes.
    const sso = join(dir, "scan-chat-allowed");
    const allowed = await cli([
      "scan", "--url", chat, ...one, "--no-chaos", "--no-coverage", "--offsite-redirect-allow", off, "--fail-on", "low", "--quiet", "--out", sso,
    ]);
    expect(allowed.status, allowed.stderr).toBe(0);
    const file3 = JSON.parse(readFileSync(join(sso, "scan-report.json"), "utf8")) as ScanReportFile;
    expect(file3.findings.filter((f) => f.rule === "open-redirect")).toEqual([]);
  }, 240_000);
});
