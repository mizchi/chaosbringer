/**
 * Visual regression invariant.
 *
 * Per page: compare the current screenshot to a baseline image on disk. If
 * the pixel diff exceeds the configured budget, fail with a one-line summary
 * and optionally write a diff PNG so CI artefacts can show what changed.
 *
 * `pixelmatch` and `pngjs` are optional peer deps — a clear install-hint
 * error is thrown if they're missing when the invariant actually runs.
 *
 * The pure helpers (`screenshotFilename`, `compareScreenshotBuffers`) are
 * unit-testable without a browser.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Invariant, UrlMatcher } from "./types.js";

export interface VisualRegressionOptions {
  /** Directory containing baseline PNGs (one per page URL, filename derived from the URL). Required. */
  baselineDir: string;
  /**
   * Per-pixel color distance threshold forwarded to pixelmatch. 0 = exact,
   * 1 = maximum. Default 0.1 — tolerant of minor antialiasing.
   */
  threshold?: number;
  /** Absolute allowance: fail only if diffPixels exceeds this. Default 0. */
  maxDiffPixels?: number;
  /** Ratio allowance: fail if diffPixels / totalPixels exceeds this. Evaluated alongside `maxDiffPixels`. */
  maxDiffRatio?: number;
  /** Directory to write diff PNGs on failure. Skipped if unset. */
  diffDir?: string;
  /**
   * Overwrite the baseline with the current screenshot on every page. Use
   * once after an intentional UI change, then disable.
   */
  updateBaseline?: boolean;
  /** Full-page screenshot (default true) vs viewport-only. */
  fullPage?: boolean;
  /** Invariant name in the report. Default `visual-regression`. */
  name?: string;
  /** Restrict to matching URLs. */
  urlPattern?: UrlMatcher;
  /** Phase. Default `afterLoad` — post-action frames are much noisier. */
  when?: Invariant["when"];
}

/**
 * Derive a filename-safe key from a URL. Encodes the path and query so two
 * different routes don't collide; strips the scheme/host since baselines
 * are per-site anyway.
 */
export function screenshotFilename(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not a URL — treat the whole string as a path.
    return sanitize(url) + ".png";
  }
  const path = u.pathname === "/" || u.pathname === "" ? "index" : u.pathname;
  const query = u.search ? `__${u.search.slice(1)}` : "";
  return sanitize(path + query) + ".png";
}

function sanitize(s: string): string {
  return s
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    || "index";
}

export interface CompareResult {
  /** Pixel width of the comparison (0 if dimensions differ). */
  width: number;
  /** Pixel height of the comparison (0 if dimensions differ). */
  height: number;
  /** Pixels that differ. */
  diffPixels: number;
  /** width*height. 0 when dimensions mismatched. */
  totalPixels: number;
  /** True when the images have matching dimensions and pixelmatch was run. */
  dimensionsMatch: boolean;
  /** Diff PNG as a Buffer (only when dimensions matched and an imageFactory was available). */
  diffBuffer?: Buffer;
}

/**
 * Compare two PNG buffers. Returns diff metrics and an optional diff image.
 * Dimension mismatches count as a full diff without per-pixel matching.
 *
 * `pixelmatch` and `pngjs` are resolved lazily so the helper can be imported
 * in environments without those peer deps — errors only surface when you
 * actually call this function without them installed.
 */
export async function compareScreenshotBuffers(
  current: Buffer,
  baseline: Buffer,
  options: { threshold?: number; emitDiff?: boolean } = {}
): Promise<CompareResult> {
  const { PNG } = await loadPngjs();
  const pixelmatch = await loadPixelmatch();

  const currImg = PNG.sync.read(current);
  const baseImg = PNG.sync.read(baseline);

  if (currImg.width !== baseImg.width || currImg.height !== baseImg.height) {
    return {
      width: 0,
      height: 0,
      diffPixels: Math.max(currImg.width * currImg.height, baseImg.width * baseImg.height),
      totalPixels: 0,
      dimensionsMatch: false,
    };
  }

  const { width, height } = currImg;
  const diffPng = options.emitDiff ? new PNG({ width, height }) : null;
  const diffPixels = pixelmatch(
    currImg.data,
    baseImg.data,
    diffPng ? diffPng.data : null,
    width,
    height,
    { threshold: options.threshold ?? 0.1 }
  );

  return {
    width,
    height,
    diffPixels,
    totalPixels: width * height,
    dimensionsMatch: true,
    diffBuffer: diffPng ? PNG.sync.write(diffPng) : undefined,
  };
}

interface PixelmatchFn {
  (
    img1: Uint8Array,
    img2: Uint8Array,
    output: Uint8Array | null,
    width: number,
    height: number,
    options?: { threshold?: number }
  ): number;
}

async function loadPixelmatch(): Promise<PixelmatchFn> {
  try {
    const mod = (await import("pixelmatch")) as unknown as {
      default?: PixelmatchFn;
    } & PixelmatchFn;
    return (mod.default ?? mod) as PixelmatchFn;
  } catch {
    throw new Error(
      "chaosbringer: invariants.visualRegression() requires the `pixelmatch` package. Install it with `pnpm add pixelmatch pngjs`."
    );
  }
}

interface PngCtor {
  new (opts: { width: number; height: number }): { data: Buffer; width: number; height: number };
  sync: {
    read: (buf: Buffer) => { data: Buffer; width: number; height: number };
    write: (png: { data: Buffer; width: number; height: number }) => Buffer;
  };
}

async function loadPngjs(): Promise<{ PNG: PngCtor }> {
  try {
    const mod = (await import("pngjs")) as unknown as { PNG: PngCtor };
    return { PNG: mod.PNG };
  } catch {
    throw new Error(
      "chaosbringer: invariants.visualRegression() requires the `pngjs` package. Install it with `pnpm add pixelmatch pngjs`."
    );
  }
}

/** Format the diff outcome into a one-line invariant failure message. */
export function formatVisualDiff(result: CompareResult, maxDiffPixels: number, maxDiffRatio?: number): string {
  if (!result.dimensionsMatch) {
    return `visual diff: dimensions mismatch (baseline differs in size)`;
  }
  const ratio = result.totalPixels > 0 ? result.diffPixels / result.totalPixels : 0;
  const parts = [`${result.diffPixels} px differ`];
  parts.push(`${(ratio * 100).toFixed(3)}%`);
  if (result.diffPixels > maxDiffPixels) parts.push(`> maxDiffPixels=${maxDiffPixels}`);
  if (maxDiffRatio !== undefined && ratio > maxDiffRatio) {
    parts.push(`> maxDiffRatio=${maxDiffRatio}`);
  }
  return `visual diff: ${parts.join(", ")}`;
}

/**
 * Visual-regression invariant. On first run (or `updateBaseline: true`),
 * saves the current screenshot as the baseline and passes. On subsequent
 * runs, compares against the baseline and fails when the diff exceeds the
 * configured budget.
 */
export function visualRegression(options: VisualRegressionOptions): Invariant {
  const threshold = options.threshold ?? 0.1;
  const maxDiffPixels = options.maxDiffPixels ?? 0;
  const maxDiffRatio = options.maxDiffRatio;
  const fullPage = options.fullPage ?? true;
  const baselineDir = options.baselineDir;
  const diffDir = options.diffDir;
  const updateBaseline = options.updateBaseline ?? false;

  return {
    name: options.name ?? "visual-regression",
    urlPattern: options.urlPattern,
    when: options.when ?? "afterLoad",
    async check({ page, url }) {
      const filename = screenshotFilename(url);
      const baselinePath = join(baselineDir, filename);

      const screenshot = await page.screenshot({ fullPage, type: "png" });
      const current = screenshot as Buffer;

      if (!existsSync(baselinePath) || updateBaseline) {
        mkdirSync(dirname(baselinePath), { recursive: true });
        writeFileSync(baselinePath, current);
        return true;
      }

      const baseline = readFileSync(baselinePath);
      const result = await compareScreenshotBuffers(current, baseline, {
        threshold,
        emitDiff: Boolean(diffDir),
      });

      const ratioExceeded =
        maxDiffRatio !== undefined &&
        result.totalPixels > 0 &&
        result.diffPixels / result.totalPixels > maxDiffRatio;
      const pixelsExceeded = result.diffPixels > maxDiffPixels;
      const failed = !result.dimensionsMatch || pixelsExceeded || ratioExceeded;

      if (failed && diffDir && result.diffBuffer) {
        const diffPath = join(diffDir, filename);
        mkdirSync(dirname(diffPath), { recursive: true });
        writeFileSync(diffPath, result.diffBuffer);
      }

      if (!failed) return true;
      return formatVisualDiff(result, maxDiffPixels, maxDiffRatio);
    },
  };
}
