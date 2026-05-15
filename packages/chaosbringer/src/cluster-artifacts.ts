/**
 * Per-cluster representative artifact bundles.
 *
 * `failure-artifacts.ts` writes one bundle per failing page, which is the
 * right granularity for reproducing a specific failure but the wrong one
 * for issue-writing: a cluster with 30 pages produces 30 directories the
 * triager has to skim. The cluster bundle picks ONE representative page
 * per cluster and copies its evidence (HTML, trace, repro.sh) into
 * `<dir>/clusters/<clusterKey>/`, alongside a `errors.json` filtered to
 * the cluster's own errors and an `info.json` with cluster metadata.
 *
 * Designed to run post-hoc against an already-written failure-artifacts
 * directory: takes the final report + the directory and produces the
 * cluster bundles without needing the crawler in the loop. That makes
 * the operation re-runnable and re-targetable (different output dirs,
 * different filtering) from a saved report.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ErrorCluster } from "./clusters.js";
import { fingerprintError } from "./clusters.js";
import type { CrawlReport, PageError } from "./types.js";

/** Files copied verbatim from the representative page bundle. */
const COPYABLE_FILES = ["page.html", "trace.jsonl", "repro.sh", "screenshot.png"] as const;
type CopyableFile = (typeof COPYABLE_FILES)[number];

export interface WriteClusterArtifactsOptions {
  /** Directory where per-page failure bundles live (i.e. failureArtifacts.dir). */
  bundleDir: string;
  /**
   * Output directory for cluster bundles. Defaults to `<bundleDir>/clusters`.
   * Keeping the default under bundleDir means the existing artefact upload
   * step in CI picks up both per-page and per-cluster bundles for free.
   */
  outputDir?: string;
  /** Maximum cluster bundles to emit. Defaults to all clusters. */
  maxClusters?: number;
  /**
   * Skip clusters whose count is below this threshold. Defaults to 1
   * (no filtering). Useful when triaging a noisy run — `--min-count 5`
   * surfaces only the recurring failures.
   */
  minCount?: number;
}

export interface ClusterArtifactResult {
  clusterKey: string;
  /** Directory written, relative to outputDir. */
  bundlePath: string;
  /** Page URL chosen as representative (cluster.urls[0]). */
  representativeUrl: string | null;
  /** True when an existing per-page bundle was found and copied from. */
  representativeBundleFound: boolean;
  /** Files actually copied (subset of COPYABLE_FILES). */
  copiedFiles: CopyableFile[];
}

interface BundleInfoJson {
  url: string;
}

/**
 * Build a map from page URL → bundle directory by reading each
 * `info.json` under `bundleDir`. Done once up front because per-page
 * bundle directory names are URL-derived but not URL-encoded — round-
 * tripping URL → dirname would re-implement `failureBundleKey` here and
 * silently break if that function evolves.
 */
function buildUrlIndex(bundleDir: string): Map<string, string> {
  const idx = new Map<string, string>();
  if (!existsSync(bundleDir)) return idx;
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "clusters") continue;
    const infoPath = join(bundleDir, entry.name, "info.json");
    if (!existsSync(infoPath)) continue;
    try {
      const info = JSON.parse(readFileSync(infoPath, "utf-8")) as BundleInfoJson;
      if (typeof info.url === "string") {
        // Prefer the earliest bundle for a given URL — the lexicographically
        // first directory name has the smallest sequence prefix.
        if (!idx.has(info.url)) idx.set(info.url, join(bundleDir, entry.name));
      }
    } catch {
      // Skip unreadable / non-JSON info files — they're not the bundles we want.
    }
  }
  return idx;
}

/**
 * Sanitise a cluster key into a filesystem-safe directory name. Cluster
 * keys are `<type>|<fingerprint>` where the fingerprint can contain
 * arbitrary characters — slashes, quotes, control chars — so we strip
 * them aggressively. The original key is preserved in the bundle's
 * `info.json`, so downstream tools that need the exact key still have
 * it.
 *
 * `|` is also stripped even though Linux/macOS accept it: GitHub
 * `actions/upload-artifact@v4` rejects paths containing `" : < > | * ?
 * \r \n`, so a cluster bundle named `console|...` fails the upload
 * step and silently kills the workflow even when the underlying
 * crawl/parity assertions all passed.
 */
function sanitizeClusterKey(key: string): string {
  return (
    key
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 80) || "cluster"
  );
}

/**
 * Filter a report's page errors down to those that belong to a
 * specific cluster. Re-runs the fingerprint hash since `errorClusters`
 * carries counts but not the individual underlying errors.
 */
function errorsForCluster(report: CrawlReport, cluster: ErrorCluster): PageError[] {
  const matches: PageError[] = [];
  for (const page of report.pages) {
    for (const err of page.errors) {
      if (err.type !== cluster.type) continue;
      if (fingerprintError(err) !== cluster.fingerprint) continue;
      matches.push(err);
    }
  }
  return matches;
}

/**
 * Write one cluster bundle per cluster in the report. Returns metadata
 * about each emitted bundle so the caller can log / surface counts.
 */
export function writeClusterArtifacts(
  report: CrawlReport,
  options: WriteClusterArtifactsOptions,
): ClusterArtifactResult[] {
  const outputDir = options.outputDir ?? join(options.bundleDir, "clusters");
  const minCount = options.minCount ?? 1;
  const max = options.maxClusters ?? Number.POSITIVE_INFINITY;

  mkdirSync(outputDir, { recursive: true });
  const urlIndex = buildUrlIndex(options.bundleDir);

  const results: ClusterArtifactResult[] = [];
  let emitted = 0;
  for (const cluster of report.errorClusters) {
    if (emitted >= max) break;
    if (cluster.count < minCount) continue;

    const dirName = sanitizeClusterKey(cluster.key);
    const bundlePath = join(outputDir, dirName);
    mkdirSync(bundlePath, { recursive: true });

    const repUrl = cluster.urls[0] ?? null;
    const sourceBundle = repUrl ? urlIndex.get(repUrl) ?? null : null;

    const copied: CopyableFile[] = [];
    if (sourceBundle) {
      for (const name of COPYABLE_FILES) {
        const src = join(sourceBundle, name);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(bundlePath, name));
        copied.push(name);
      }
    }

    const errors = errorsForCluster(report, cluster);
    writeFileSync(join(bundlePath, "errors.json"), JSON.stringify(errors, null, 2));

    const info = {
      clusterKey: cluster.key,
      type: cluster.type,
      fingerprint: cluster.fingerprint,
      count: cluster.count,
      urls: cluster.urls,
      invariantNames: cluster.invariantNames,
      representative: {
        url: repUrl,
        bundleDir: sourceBundle ? basename(sourceBundle) : null,
      },
      copiedFiles: copied,
      baseUrl: report.baseUrl,
      seed: report.seed,
    };
    writeFileSync(join(bundlePath, "info.json"), JSON.stringify(info, null, 2));

    results.push({
      clusterKey: cluster.key,
      bundlePath,
      representativeUrl: repUrl,
      representativeBundleFound: !!sourceBundle,
      copiedFiles: copied,
    });
    emitted++;
  }
  return results;
}
