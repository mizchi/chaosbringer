/**
 * `--invariants` / `--data-safety` from the shell, on a two-page site with
 * the damage that doesn't throw: a total rendered as `NaN`, and a query
 * parameter written into the page with `innerHTML`. `--strict` passes both,
 * which is why the flags exist; the presets were reachable only from code.
 *
 * The payload only sets a marker (`window.__cb_xss_fired`), and every URL is
 * the test server's own.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanReportFile } from "./scan/run.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlReport } from "./types.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Async, not spawnSync: the test server answers from this process's event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: PACKAGE_DIR, timeout: 90_000 }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ status, stdout, stderr });
    });
  });
}

const PAYLOAD = '<details open ontoggle="window.__cb_xss_fired=1"></details>';

describe("--invariants / --data-safety on the command line", () => {
  let server: TestServer;
  let dir: string;
  let nan: string;
  let reflected: string;
  const one = ["--max-pages", "1", "--max-actions", "0", "--seed", "1"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cli-invariants-"));
    server = await startTestServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      res.writeHead(200, { "content-type": "text/html" });
      if (path === "/nan") {
        res.end(`<!doctype html><title>cart</title><p id="t"></p><script>
          document.getElementById("t").textContent = "Total: " + (Number("12,5") * 2) + " EUR";
        </script>`);
        return;
      }
      // Reflected through innerHTML, and a total that went wrong.
      res.end(`<!doctype html><title>search</title><div id="q"></div><p>Total: NaN EUR</p><script>
        document.getElementById("q").innerHTML = new URLSearchParams(location.search).get("q") ?? "";
      </script>`);
    });
    nan = `${server.url}/nan`;
    reflected = `${server.url}/r?q=${encodeURIComponent(PAYLOAD)}`;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("--strict alone passes a page that shows Total: NaN EUR", async () => {
    const r = await cli(["--url", nan, ...one, "--strict", "--compact", "--output", join(dir, "strict.json")]);
    expect(r.stdout).toMatch(/^\[PASS\] 1 pages, 0 errors,/m);
    expect(r.status).toBe(0);
  }, 120_000);

  it("--data-safety fails it on data.rendered-garbage, in every output that reports the run", async () => {
    const output = join(dir, "data-safety.json");
    const junit = join(dir, "data-safety.xml");
    const r = await cli([
      "--url", nan, ...one, "--strict", "--data-safety", "--compact", "--github-annotations",
      "--output", output, "--junit", junit,
    ]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^\[FAIL\] 1 pages, 1 errors,/m);
    expect(r.stdout).toContain("  Failed: 1 invariant violation");
    expect(r.stdout).toContain('[invariant-violation] [data.rendered-garbage] rendered garbage: NaN in "Total: NaN EUR"');
    expect(r.stdout).toMatch(/^::error title=\[invariant-violation\] \[data.rendered-garbage\]/m);
    // The Repro line turns the same checks on, and notes nothing it cannot.
    const repro = r.stdout.split("\n").find((l) => l.includes("Repro:")) ?? "";
    expect(repro).toContain(" --invariants data-safety");
    expect(repro).not.toContain("#");
    const report = JSON.parse(readFileSync(output, "utf8")) as CrawlReport;
    expect(report.pages[0]!.errors.map((e) => e.invariantName)).toEqual(["data.rendered-garbage"]);
    expect(readFileSync(junit, "utf8")).toContain("[invariant-violation:data.rendered-garbage]");
  }, 120_000);

  it("--invariants xss-marker catches a payload a query string reflects, which --strict passes", async () => {
    const strict = await cli(["--url", reflected, ...one, "--strict", "--compact", "--output", join(dir, "xss-strict.json")]);
    expect(strict.status).toBe(0);
    const r = await cli(["--url", reflected, ...one, "--invariants", "xss-marker", "--compact", "--output", join(dir, "xss.json")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[invariant-violation] [data.xss-marker] XSS marker set: window.__cb_xss_fired");
    // Only the one named: no rendered-garbage for the page's NaN.
    expect(r.stdout).not.toContain("data.rendered-garbage");
  }, 120_000);

  it("scan --data-safety reports each as a finding, and --fail-on high stops on the payload that ran", async () => {
    const out = join(dir, "scan");
    const r = await cli(["scan", "--url", reflected, ...one, "--no-chaos", "--no-coverage", "--data-safety", "--fail-on", "high", "--quiet", "--out", out]);
    expect(r.status).toBe(1);
    const file = JSON.parse(readFileSync(join(out, "scan-report.json"), "utf8")) as ScanReportFile;
    const found = file.findings
      .filter((f) => f.rule === "invariant-violation")
      .map((f) => [f.title.match(/\[(data\.[a-z-]+)\]/)?.[1], f.severity, f.category])
      .sort();
    expect(found).toEqual([
      ["data.injected-markup", "high", "bug"],
      ["data.rendered-garbage", "medium", "bug"],
      ["data.xss-marker", "high", "bug"],
    ]);
    // The clean crawl's Repro line is a plain crawl with the same checks.
    const clean = JSON.parse(readFileSync(join(out, "clean-report.json"), "utf8")) as CrawlReport;
    expect(clean.reproCommand).toContain(" --invariants data-safety");
    expect(clean.reproCommand).not.toContain("#");
  }, 120_000);
});
