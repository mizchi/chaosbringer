import { describe, expect, it } from "vitest";
import type { MediaReport } from "./report-types";
import { keepTextualUncompressed } from "./session";

const media = (urls: string[]): MediaReport => ({
  imageCount: 0,
  imageKB: 0,
  oversized: [],
  uncompressed: urls.map((url) => ({ url, kb: 100, ratio: 1, type: "fetch" })),
  oversizedCount: 0,
  uncompressedCount: urls.length,
});

describe("keepTextualUncompressed", () => {
  it("keeps text by its CDP MIME type, drops typed binary and untyped non-text names", () => {
    const m = media([
      "https://x.test/api/products?page=1",
      "https://x.test/models/car.pts",
      "https://x.test/app.js",
      "https://x.test/fonts/inter.ttf",
      "https://x.test/archive.dat",
      "https://x.test/not-captured",
    ]);
    keepTextualUncompressed(m, [
      { url: "https://x.test/api/products?page=1", mimeType: "application/json" },
      { url: "https://x.test/models/car.pts", mimeType: "" },
      { url: "https://x.test/app.js", mimeType: "" },
      { url: "https://x.test/fonts/inter.ttf", mimeType: "font/ttf" },
      { url: "https://x.test/archive.dat", mimeType: "application/octet-stream" },
    ]);
    expect(m.uncompressed.map((u) => u.url)).toEqual([
      "https://x.test/api/products?page=1",
      "https://x.test/app.js",
      "https://x.test/fonts/inter.ttf",
      "https://x.test/not-captured",
    ]);
    expect(m.uncompressedCount).toBe(4);
  });
});
