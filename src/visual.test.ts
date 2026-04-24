import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import {
  compareScreenshotBuffers,
  formatVisualDiff,
  screenshotFilename,
  type CompareResult,
} from "./visual.js";

/** Build a solid-color PNG buffer of the given size. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = rgba[0]!;
    png.data[i + 1] = rgba[1]!;
    png.data[i + 2] = rgba[2]!;
    png.data[i + 3] = rgba[3]!;
  }
  return PNG.sync.write(png);
}

describe("screenshotFilename", () => {
  it("maps / to index.png", () => {
    expect(screenshotFilename("http://localhost:3000/")).toBe("index.png");
  });

  it("maps a nested path", () => {
    expect(screenshotFilename("http://x/docs/intro/")).toBe("docs_intro.png");
  });

  it("incorporates the query so different searches don't collide", () => {
    const a = screenshotFilename("http://x/search?q=foo");
    const b = screenshotFilename("http://x/search?q=bar");
    expect(a).not.toBe(b);
    expect(a.endsWith(".png")).toBe(true);
  });

  it("sanitizes unsafe characters", () => {
    const name = screenshotFilename("http://x/a b/c:d?e=1");
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("falls back to index when the URL is unparseable", () => {
    expect(screenshotFilename("not-a-url")).toBe("not-a-url.png");
  });
});

describe("compareScreenshotBuffers", () => {
  it("reports zero diff for identical images", async () => {
    const a = solidPng(10, 10, [200, 50, 50, 255]);
    const b = solidPng(10, 10, [200, 50, 50, 255]);
    const r = await compareScreenshotBuffers(a, b);
    expect(r.dimensionsMatch).toBe(true);
    expect(r.diffPixels).toBe(0);
    expect(r.totalPixels).toBe(100);
  });

  it("reports every pixel as diff when colors differ fully", async () => {
    const a = solidPng(4, 4, [0, 0, 0, 255]);
    const b = solidPng(4, 4, [255, 255, 255, 255]);
    const r = await compareScreenshotBuffers(a, b, { threshold: 0.1 });
    expect(r.diffPixels).toBe(16);
  });

  it("flags dimension mismatch without running pixelmatch", async () => {
    const a = solidPng(10, 10, [0, 0, 0, 255]);
    const b = solidPng(5, 10, [0, 0, 0, 255]);
    const r = await compareScreenshotBuffers(a, b);
    expect(r.dimensionsMatch).toBe(false);
    expect(r.totalPixels).toBe(0);
    expect(r.diffPixels).toBeGreaterThan(0);
  });

  it("emits a diff PNG when requested", async () => {
    const a = solidPng(4, 4, [0, 0, 0, 255]);
    const b = solidPng(4, 4, [255, 255, 255, 255]);
    const r = await compareScreenshotBuffers(a, b, { emitDiff: true });
    expect(r.diffBuffer).toBeDefined();
    // Verify the diff is itself a readable PNG.
    const decoded = PNG.sync.read(r.diffBuffer!);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
  });

  it("omits the diff PNG when emitDiff is false (default)", async () => {
    const a = solidPng(4, 4, [0, 0, 0, 255]);
    const b = solidPng(4, 4, [255, 255, 255, 255]);
    const r = await compareScreenshotBuffers(a, b);
    expect(r.diffBuffer).toBeUndefined();
  });
});

describe("formatVisualDiff", () => {
  const ok = (diffPixels: number, totalPixels: number): CompareResult => ({
    width: 100,
    height: 100,
    diffPixels,
    totalPixels,
    dimensionsMatch: true,
  });

  it("reports px + percentage", () => {
    const s = formatVisualDiff(ok(50, 10000), 0);
    expect(s).toContain("50 px differ");
    expect(s).toContain("0.500%");
  });

  it("annotates when maxDiffPixels is exceeded", () => {
    const s = formatVisualDiff(ok(50, 10000), 10);
    expect(s).toContain("> maxDiffPixels=10");
  });

  it("annotates when maxDiffRatio is exceeded", () => {
    const s = formatVisualDiff(ok(200, 10000), 0, 0.01);
    expect(s).toContain("> maxDiffRatio=0.01");
  });

  it("describes dimension mismatch explicitly", () => {
    const s = formatVisualDiff(
      { width: 0, height: 0, diffPixels: 100, totalPixels: 0, dimensionsMatch: false },
      0
    );
    expect(s).toContain("dimensions mismatch");
  });
});
