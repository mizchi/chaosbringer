import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { runDiffCli } from "./diff-cli.js";
import type { CrawlReport, CrawlSummary, PageError } from "./types.js";

function cluster(o: Partial<ErrorCluster> & { key: string; fingerprint: string; message?: string }): ErrorCluster {
  const sample: PageError = { type: "console", message: o.message ?? o.fingerprint, timestamp: 0 };
  return {
    key: o.key,
    type: o.type ?? "console",
    fingerprint: o.fingerprint,
    sample,
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

describe("runDiffCli", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-diff-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
  });

  function writeReport(name: string, report: CrawlReport): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(report));
    return p;
  }

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("classifies clusters into left-only, right-only, and shared", async () => {
    const leftPath = writeReport(
      "left.json",
      makeReport({
        errorClusters: [
          cluster({ key: "console|only-left", fingerprint: "only-left", count: 2 }),
          cluster({ key: "console|shared", fingerprint: "shared", count: 5 }),
        ],
      }),
    );
    const rightPath = writeReport(
      "right.json",
      makeReport({
        errorClusters: [
          cluster({ key: "console|only-right", fingerprint: "only-right", count: 1 }),
          cluster({ key: "console|shared", fingerprint: "shared", count: 4 }),
        ],
      }),
    );
    await runDiffCli([leftPath, rightPath, "--json"]);
    const out = JSON.parse(output());
    expect(out.leftOnlyClusters.map((c: { key: string }) => c.key)).toEqual([
      "console|only-left",
    ]);
    expect(out.rightOnlyClusters.map((c: { key: string }) => c.key)).toEqual([
      "console|only-right",
    ]);
    expect(out.sharedClusters.map((c: { key: string }) => c.key)).toEqual(["console|shared"]);
  });

  it("lists clusters on both sides as shared, not as noise, with a raw message the key leaves out", async () => {
    const shared = [
      // The fixture's own exception: the app's bug on both sides, not noise.
      cluster({ key: "exception|fixture: boom", fingerprint: "fixture: boom", type: "exception" }),
      cluster({
        key: "console|Failed to load <url>",
        fingerprint: "Failed to load <url>",
        message: "Failed to load https://cdn.example.test/app.js",
      }),
    ];
    const leftPath = writeReport("left.json", makeReport({ errorClusters: shared }));
    const rightPath = writeReport(
      "right.json",
      makeReport({
        errorClusters: [
          ...shared,
          cluster({ key: "console|HTTP <n> on <url>", fingerprint: "HTTP <n> on <url>", message: "HTTP 500 on /api/x" }),
        ],
      }),
    );
    await runDiffCli([leftPath, rightPath]);
    const lines = output().split("\n");
    expect(lines).not.toContainEqual(expect.stringContaining("noise"));
    const at = lines.indexOf("Shared (both sides):");
    expect(lines.slice(at, at + 4)).toEqual([
      "Shared (both sides):",
      "  [exception] exception|fixture: boom (left=1, right=1)",
      "  [console] console|Failed to load <url> (left=1, right=1)",
      "      e.g. Failed to load https://cdn.example.test/app.js",
    ]);
    expect(lines).toContain("      e.g. HTTP 500 on /api/x");

    logSpy.mockClear();
    await runDiffCli([leftPath, rightPath, "--json"]);
    const json = JSON.parse(output());
    expect(json.sharedClusters.map((c: { sample: string }) => c.sample)).toEqual([
      "fixture: boom",
      "Failed to load https://cdn.example.test/app.js",
    ]);
    expect(json.rightOnlyClusters[0].sample).toBe("HTTP 500 on /api/x");
  });

  it("--right-only filters to clusters present only on the right", async () => {
    const leftPath = writeReport(
      "left.json",
      makeReport({ errorClusters: [cluster({ key: "console|shared", fingerprint: "shared" })] }),
    );
    const rightPath = writeReport(
      "right.json",
      makeReport({
        errorClusters: [
          cluster({ key: "console|shared", fingerprint: "shared" }),
          cluster({ key: "console|only-right", fingerprint: "only-right", count: 3 }),
        ],
      }),
    );
    await runDiffCli([leftPath, rightPath, "--right-only"]);
    const out = output();
    expect(out).toContain("console|only-right");
    expect(out).not.toContain("console|shared");
  });

  it("exits with code 1 and prints help when positionals are missing", async () => {
    await runDiffCli(["only-one.json"]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("throws a clear error for a non-report JSON file", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ totally: "wrong" }));
    const other = writeReport("right.json", makeReport());
    await expect(runDiffCli([bad, other])).rejects.toThrow(/not a chaos report/);
  });

  it("--help prints usage and exits cleanly", async () => {
    await runDiffCli(["--help"]);
    const out = output();
    expect(out).toMatch(/Usage: chaosbringer diff/);
    expect(process.exitCode).toBe(0);
  });
});
