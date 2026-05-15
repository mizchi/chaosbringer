import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { writeClusterArtifacts } from "./cluster-artifacts.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function err(o: Partial<PageError> & { type: PageError["type"]; message: string }): PageError {
  return {
    timestamp: 0,
    ...o,
  };
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

describe("writeClusterArtifacts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chaos-cluster-artifacts-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeBundle(name: string, info: { url: string }, files: Record<string, string>): string {
    const bundlePath = join(dir, name);
    mkdirSync(bundlePath, { recursive: true });
    writeFileSync(join(bundlePath, "info.json"), JSON.stringify(info));
    for (const [filename, content] of Object.entries(files)) {
      writeFileSync(join(bundlePath, filename), content);
    }
    return bundlePath;
  }

  it("emits one cluster bundle per cluster with copied files + filtered errors", () => {
    makeBundle("0000__app_x__abcdef01", { url: "http://app/x" }, {
      "page.html": "<html>x</html>",
      "trace.jsonl": '{"event":"visit"}',
      "repro.sh": "#!/bin/sh\necho x",
    });
    const errA = err({ type: "console", message: "boom 123", url: "http://app/x" });
    const errB = err({ type: "console", message: "boom 456", url: "http://app/x" });
    const errOther = err({ type: "network", message: "other", url: "http://app/x" });
    const report = makeReport({
      pages: [page({ url: "http://app/x", errors: [errA, errB, errOther] })],
      errorClusters: [
        cluster({
          key: "console|boom <n>",
          type: "console",
          fingerprint: "boom <n>",
          sample: errA,
          count: 2,
          urls: ["http://app/x"],
        }),
      ],
    });

    const results = writeClusterArtifacts(report, { bundleDir: dir });
    expect(results).toHaveLength(1);
    const out = results[0];
    expect(out.representativeBundleFound).toBe(true);
    expect(out.copiedFiles).toEqual(expect.arrayContaining(["page.html", "trace.jsonl", "repro.sh"]));

    // Copied files exist in cluster bundle.
    expect(readFileSync(join(out.bundlePath, "page.html"), "utf-8")).toBe("<html>x</html>");
    expect(readFileSync(join(out.bundlePath, "trace.jsonl"), "utf-8")).toBe('{"event":"visit"}');

    // errors.json filtered to ONLY the two console "boom" errors (not the network one).
    const errors = JSON.parse(readFileSync(join(out.bundlePath, "errors.json"), "utf-8"));
    expect(errors).toHaveLength(2);
    expect(errors.every((e: PageError) => e.type === "console")).toBe(true);

    // info.json carries cluster metadata + the original key.
    const info = JSON.parse(readFileSync(join(out.bundlePath, "info.json"), "utf-8"));
    expect(info.clusterKey).toBe("console|boom <n>");
    expect(info.count).toBe(2);
    expect(info.representative.url).toBe("http://app/x");
  });

  it("writes errors.json + info.json even when no per-page bundle is found", () => {
    // Cluster's representative URL has no failure bundle on disk.
    const sample = err({ type: "console", message: "no bundle", url: "http://app/y" });
    const report = makeReport({
      pages: [page({ url: "http://app/y", errors: [sample] })],
      errorClusters: [
        cluster({
          key: "console|no bundle",
          fingerprint: "no bundle",
          sample,
          count: 1,
          urls: ["http://app/y"],
        }),
      ],
    });

    const [result] = writeClusterArtifacts(report, { bundleDir: dir });
    expect(result.representativeBundleFound).toBe(false);
    expect(result.copiedFiles).toEqual([]);
    expect(existsSync(join(result.bundlePath, "errors.json"))).toBe(true);
    expect(existsSync(join(result.bundlePath, "info.json"))).toBe(true);
    expect(existsSync(join(result.bundlePath, "page.html"))).toBe(false);
  });

  it("honours minCount to filter low-frequency clusters", () => {
    const sample = err({ type: "console", message: "rare", url: "http://app/z" });
    const report = makeReport({
      pages: [page({ url: "http://app/z", errors: [sample] })],
      errorClusters: [
        cluster({ key: "console|rare", fingerprint: "rare", sample, count: 1, urls: ["http://app/z"] }),
        cluster({ key: "console|frequent", fingerprint: "frequent", sample, count: 10, urls: ["http://app/z"] }),
      ],
    });
    const results = writeClusterArtifacts(report, { bundleDir: dir, minCount: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].clusterKey).toBe("console|frequent");
  });

  it("honours maxClusters", () => {
    const sample = err({ type: "console", message: "x", url: "http://app/a" });
    const report = makeReport({
      errorClusters: [
        cluster({ key: "console|a", fingerprint: "a", sample, count: 3 }),
        cluster({ key: "console|b", fingerprint: "b", sample, count: 2 }),
        cluster({ key: "console|c", fingerprint: "c", sample, count: 1 }),
      ],
    });
    const results = writeClusterArtifacts(report, { bundleDir: dir, maxClusters: 2 });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.clusterKey)).toEqual(["console|a", "console|b"]);
  });

  it("respects custom outputDir", () => {
    const sample = err({ type: "console", message: "x", url: "http://app/a" });
    const report = makeReport({
      errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample })],
    });
    const customOut = join(dir, "elsewhere");
    const [result] = writeClusterArtifacts(report, { bundleDir: dir, outputDir: customOut });
    expect(result.bundlePath.startsWith(customOut)).toBe(true);
  });

  it("ignores existing 'clusters' subdirectory when indexing bundles", () => {
    // Simulate a previous run: the per-page bundle dir already contains a
    // `clusters/` subdir. It must not be misread as a page bundle.
    mkdirSync(join(dir, "clusters", "left-over"), { recursive: true });
    writeFileSync(join(dir, "clusters", "left-over", "info.json"), JSON.stringify({ url: "http://noise" }));
    makeBundle("0000__app_x__deadbeef", { url: "http://app/x" }, { "page.html": "x" });

    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const report = makeReport({
      pages: [page({ url: "http://app/x", errors: [sample] })],
      errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample, urls: ["http://app/x"] })],
    });
    const [result] = writeClusterArtifacts(report, { bundleDir: dir });
    expect(result.representativeBundleFound).toBe(true);
  });

  it("returns an empty result list for a report with no error clusters", () => {
    const results = writeClusterArtifacts(makeReport(), { bundleDir: dir });
    expect(results).toEqual([]);
  });

  it("tolerates a non-existent bundleDir (no representative bundle, errors.json still written)", () => {
    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const report = makeReport({
      pages: [page({ url: "http://app/x", errors: [sample] })],
      errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample, urls: ["http://app/x"] })],
    });
    const ghostDir = join(dir, "does-not-exist");
    const outputDir = join(dir, "out");
    const [result] = writeClusterArtifacts(report, { bundleDir: ghostDir, outputDir });
    expect(result.representativeBundleFound).toBe(false);
    expect(result.copiedFiles).toEqual([]);
    expect(readFileSync(join(result.bundlePath, "errors.json"), "utf-8")).toContain("x");
  });

  it("picks the earliest sequence-prefixed bundle when multiple bundles exist for one URL", () => {
    // Two bundles for the same URL (e.g. crawled twice across recovery). The
    // index should prefer the lexicographically earliest dirname so triagers
    // see the first failure occurrence.
    makeBundle("0002__later", { url: "http://app/x" }, { "page.html": "later" });
    makeBundle("0001__earlier", { url: "http://app/x" }, { "page.html": "earlier" });
    const sample = err({ type: "console", message: "x", url: "http://app/x" });
    const report = makeReport({
      pages: [page({ url: "http://app/x", errors: [sample] })],
      errorClusters: [cluster({ key: "console|x", fingerprint: "x", sample, urls: ["http://app/x"] })],
    });
    const [result] = writeClusterArtifacts(report, { bundleDir: dir });
    expect(readFileSync(join(result.bundlePath, "page.html"), "utf-8")).toBe("earlier");
  });

  it("sanitises cluster keys with special characters into safe directory names", () => {
    // Real fingerprints can contain "/", spaces, quotes, etc. The output
    // dirname must not contain path separators or shell metacharacters.
    const sample = err({ type: "console", message: "a/b 'c'", url: "http://app/x" });
    const report = makeReport({
      errorClusters: [
        cluster({
          key: 'console|a/b "c" foo<bar>',
          fingerprint: 'a/b "c" foo<bar>',
          sample,
        }),
      ],
    });
    const [result] = writeClusterArtifacts(report, { bundleDir: dir });
    const dirName = result.bundlePath.split("/").pop()!;
    expect(dirName).not.toMatch(/[\\/"<>'`\s]/);
    // `|` is also forbidden — GitHub `actions/upload-artifact@v4`
    // rejects it, so the chaos cluster bundles can no longer carry
    // the `<type>|<fingerprint>` separator into the dirname.
    expect(dirName).not.toMatch(/\|/);
    // The original key is preserved in info.json for downstream tools.
    const info = JSON.parse(readFileSync(join(result.bundlePath, "info.json"), "utf-8"));
    expect(info.clusterKey).toBe('console|a/b "c" foo<bar>');
  });
});
