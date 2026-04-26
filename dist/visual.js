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
import { fnv1a } from "./shard.js";
/**
 * Derive a filename-safe key from a URL. The readable prefix carries the
 * path + query (sanitized), and an 8-hex-char hash of the full URL is
 * appended so collisions between routes that sanitize to the same prefix
 * (e.g. `/a/b` and `/a_b` both flatten to `a_b`) are impossible in
 * practice. The hash is FNV-1a — non-cryptographic, just deterministic
 * and uniformly distributed enough for filename disambiguation.
 */
export function screenshotFilename(url) {
    let prefix;
    try {
        const u = new URL(url);
        const path = u.pathname === "/" || u.pathname === "" ? "index" : u.pathname;
        const query = u.search ? `__${u.search.slice(1)}` : "";
        prefix = sanitize(path + query);
    }
    catch {
        prefix = sanitize(url);
    }
    const hash = fnv1a(url).toString(16).padStart(8, "0");
    return `${prefix}__${hash}.png`;
}
function sanitize(s) {
    return s
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        || "index";
}
/**
 * Compare two PNG buffers. Returns diff metrics and an optional diff image.
 * Dimension mismatches count as a full diff without per-pixel matching.
 *
 * `pixelmatch` and `pngjs` are resolved lazily so the helper can be imported
 * in environments without those peer deps — errors only surface when you
 * actually call this function without them installed.
 */
export async function compareScreenshotBuffers(current, baseline, options = {}) {
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
    const diffPixels = pixelmatch(currImg.data, baseImg.data, diffPng ? diffPng.data : null, width, height, { threshold: options.threshold ?? 0.1 });
    return {
        width,
        height,
        diffPixels,
        totalPixels: width * height,
        dimensionsMatch: true,
        diffBuffer: diffPng ? PNG.sync.write(diffPng) : undefined,
    };
}
async function loadPixelmatch() {
    try {
        const mod = (await import("pixelmatch"));
        return (mod.default ?? mod);
    }
    catch {
        throw new Error("chaosbringer: invariants.visualRegression() requires the `pixelmatch` package. Install it with `pnpm add pixelmatch pngjs`.");
    }
}
async function loadPngjs() {
    try {
        const mod = (await import("pngjs"));
        return { PNG: mod.PNG };
    }
    catch {
        throw new Error("chaosbringer: invariants.visualRegression() requires the `pngjs` package. Install it with `pnpm add pixelmatch pngjs`.");
    }
}
/** Format the diff outcome into a one-line invariant failure message. */
export function formatVisualDiff(result, maxDiffPixels, maxDiffRatio) {
    if (!result.dimensionsMatch) {
        return `visual diff: dimensions mismatch (baseline differs in size)`;
    }
    const ratio = result.totalPixels > 0 ? result.diffPixels / result.totalPixels : 0;
    const parts = [`${result.diffPixels} px differ`];
    parts.push(`${(ratio * 100).toFixed(3)}%`);
    if (result.diffPixels > maxDiffPixels)
        parts.push(`> maxDiffPixels=${maxDiffPixels}`);
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
export function visualRegression(options) {
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
            const current = screenshot;
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
            const ratioExceeded = maxDiffRatio !== undefined &&
                result.totalPixels > 0 &&
                result.diffPixels / result.totalPixels > maxDiffRatio;
            const pixelsExceeded = result.diffPixels > maxDiffPixels;
            const failed = !result.dimensionsMatch || pixelsExceeded || ratioExceeded;
            if (failed && diffDir && result.diffBuffer) {
                const diffPath = join(diffDir, filename);
                mkdirSync(dirname(diffPath), { recursive: true });
                writeFileSync(diffPath, result.diffBuffer);
            }
            if (!failed)
                return true;
            return formatVisualDiff(result, maxDiffPixels, maxDiffRatio);
        },
    };
}
