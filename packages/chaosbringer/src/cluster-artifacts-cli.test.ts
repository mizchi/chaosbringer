import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { runClusterArtifactsCli } from "./cluster-artifacts-cli.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function err(o: Partial<PageError> & { type: PageError["type"]; message: string }): PageError {
  return { timestamp: 0, ...o };
}

function cluster(o: Partial<ErrorCluster> & { key: string; fingerprint: string; sample: PageError }): ErrorCluster {
  return {
    key: o.key,
    type: o.type ?? "console",
    fingerprint: o.fingerprint,
    sample: o.sample,
    count: o.count ?? 1,
    urls: o.urls ?? [],
    invariantNames: o.invariantNames,
  };
}

function makeSummary(): CrawlSummary {
  return {
    successPages: 0,
    errorPages: 0,
    timeoutPages: 0,
    recoveredPages: 0,
    pagesWithErrors: 0,
    consoleErrors: 0,
    networkErrors: 0,
    jsExceptions: 0,
    unhandledRejections: 0,
    invariantViolations: 0,
    avgLoadTime: 0,
  };
}

function makeReport(overrides: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://localhost:3000",
    seed: 1,
    reproCommand: "chaosbringer",
    startTime: 0,
    endTime: 0,
    duration: 0,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: makeSummary(),
    errorClusters: [],
    ...overrides,
  };
}

function page(o: Partial<PageResult> & { url: string; errors: PageError[] }): PageResult {
  return {
    url: o.url,
    status: o.status ?? "success",
    loadTime: 0,
    errors: o.errors,
    hasErrors: o.errors.length > 0,
    warnings: [],
    links: [],
    ...o,
  };
}

describe("runClusterArtifactsCli", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-ca-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  function logged(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  function writeReportFile(name: string, report: CrawlReport): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(report));
    return p;
  }

  function makeBundle(name: string, info: { url: string }, files: Record<string, string>): string {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "info.json"), JSON.stringify(info));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(p, n), c);
    return p;
  }

  it("emits a bundle and reports it to stdout", async () => {
    makeBundle("0000__page", { url: "http://app/x" }, {
      "page.html": "<x/>",
      "trace.jsonl": "{}",
      "repro.sh": "#!/bin/sh",
    });
    const sample = err({ type: "console", message: "boom", url: "http://app/x" });
    const reportPath = writeReportFile(
      "report.json",
      makeReport({
        pages: [page({ url: "http://app/x", errors: [sample] })],
        errorClusters: [
          cluster({ key: "console|boom", fingerprint: "boom", sample, urls: ["http://app/x"] }),
        ],
      }),
    );
    await runClusterArtifactsCli([reportPath, "--bundle-dir", dir]);
    const out = logged();
    expect(out).toContain("Wrote 1 cluster bundle(s).");
    expect(out).toContain("console|boom");
    // `process.exitCode` is undefined by default; either undefined or 0 is success.
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("emits JSON when --json is set", async () => {
    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const reportPath = writeReportFile(
      "report.json",
      makeReport({
        errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample })],
      }),
    );
    await runClusterArtifactsCli([reportPath, "--bundle-dir", dir, "--json"]);
    const parsed = JSON.parse(logged());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].clusterKey).toBe("console|x");
  });

  it("forwards --min-count to the underlying writer", async () => {
    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const reportPath = writeReportFile(
      "report.json",
      makeReport({
        errorClusters: [
          cluster({ key: "console|low", fingerprint: "low", sample, count: 1 }),
          cluster({ key: "console|hi", fingerprint: "hi", sample, count: 10 }),
        ],
      }),
    );
    await runClusterArtifactsCli([reportPath, "--bundle-dir", dir, "--min-count", "5", "--json"]);
    const parsed = JSON.parse(logged());
    expect(parsed.results.map((r: { clusterKey: string }) => r.clusterKey)).toEqual(["console|hi"]);
  });

  it("exits 1 when --bundle-dir is missing", async () => {
    const reportPath = writeReportFile("report.json", makeReport());
    await runClusterArtifactsCli([reportPath]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("exits 1 when no positional report is given", async () => {
    await runClusterArtifactsCli(["--bundle-dir", dir]);
    expect(process.exitCode).toBe(1);
  });

  it("--help prints usage", async () => {
    await runClusterArtifactsCli(["--help"]);
    expect(logged()).toContain("Usage: chaosbringer cluster-artifacts");
  });

  it("throws on a non-report JSON file", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ totally: "wrong" }));
    await expect(
      runClusterArtifactsCli([bad, "--bundle-dir", dir]),
    ).rejects.toThrow(/not a chaos report/);
  });

  it("honours --output-dir for the bundle destination", async () => {
    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const reportPath = writeReportFile(
      "report.json",
      makeReport({
        errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample })],
      }),
    );
    const customOut = join(dir, "elsewhere");
    await runClusterArtifactsCli([
      reportPath,
      "--bundle-dir",
      dir,
      "--output-dir",
      customOut,
      "--json",
    ]);
    const parsed = JSON.parse(logged());
    expect(parsed.results[0].bundlePath.startsWith(customOut)).toBe(true);
    // Ensure info.json actually exists in the custom location.
    expect(readFileSync(join(parsed.results[0].bundlePath, "info.json"), "utf-8")).toContain(
      "clusterKey",
    );
  });
});
