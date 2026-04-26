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
 * Derive a filename-safe key from a URL. The readable prefix carries the
 * path + query (sanitized), and an 8-hex-char hash of the full URL is
 * appended so collisions between routes that sanitize to the same prefix
 * (e.g. `/a/b` and `/a_b` both flatten to `a_b`) are impossible in
 * practice. The hash is FNV-1a — non-cryptographic, just deterministic
 * and uniformly distributed enough for filename disambiguation.
 */
export declare function screenshotFilename(url: string): string;
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
export declare function compareScreenshotBuffers(current: Buffer, baseline: Buffer, options?: {
    threshold?: number;
    emitDiff?: boolean;
}): Promise<CompareResult>;
/** Format the diff outcome into a one-line invariant failure message. */
export declare function formatVisualDiff(result: CompareResult, maxDiffPixels: number, maxDiffRatio?: number): string;
/**
 * Visual-regression invariant. On first run (or `updateBaseline: true`),
 * saves the current screenshot as the baseline and passes. On subsequent
 * runs, compares against the baseline and fails when the diff exceeds the
 * configured budget.
 */
export declare function visualRegression(options: VisualRegressionOptions): Invariant;
//# sourceMappingURL=visual.d.ts.map