import { definePattern, html, page, type Variant } from "../pattern.js";

const WIDTH = 1600;
const HEIGHT = 1000;

// A drawing app exports the canvas as a WebP image. The canvas is filled
// with seeded noise on load (a photo-like worst case for the encoder), so
// the encode is a few hundred milliseconds of work.
//
// The slow page calls canvas.toDataURL("image/webp"): the encode runs
// synchronously inside the click handler, on the main thread, and then
// builds a base64 string a third larger than the file. The fixed page calls
// canvas.toBlob(cb, "image/webp"): Chromium encodes WebP on a worker thread
// and calls back with a Blob, which becomes an object URL for the download
// link; the main thread only copies the pixels out.
//
// Only the encoder's thread differs, and it differs per format: in headless
// Chromium toBlob() still encodes PNG and JPEG on the main thread, in
// idle-time slices (the same total task time as toDataURL, just no single
// long task); WebP is the format it hands to a worker.
const exporters: Record<Variant, string> = {
  slow: `
    document.getElementById("export").addEventListener("click", () => {
      const url = canvas.toDataURL("image/webp", 0.9);
      showLink(url, (url.length * 3) / 4);
    });`,
  fixed: `
    document.getElementById("export").addEventListener("click", () => {
      canvas.toBlob((blob) => {
        const old = document.querySelector("#download a");
        if (old) URL.revokeObjectURL(old.href);
        showLink(URL.createObjectURL(blob), blob.size);
      }, "image/webp", 0.9);
    });`,
};

export default definePattern({
  id: "canvas-to-dataurl-sync",
  title: "Synchronous canvas.toDataURL() export",
  category: "main-thread",
  description: `Clicking "Export as WebP" freezes the page for a few hundred milliseconds. The handler calls canvas.toDataURL("image/webp") on a ${WIDTH}×${HEIGHT} canvas, which encodes the image synchronously on the main thread (and then base64-encodes it into a string a third larger than the file), so nothing paints or responds until the encoder is done.`,
  fix: "Export with canvas.toBlob() (or OffscreenCanvas.convertToBlob() in a worker) and hand the Blob to URL.createObjectURL / FormData instead of a data: URL; check per format where the browser encodes (Chromium moves WebP off the main thread, but slices PNG and JPEG on it), and do the encode in a worker when it must not touch the main thread.",
  routes: (variant) => ({
    "/": html(
      page(
        "Sketch",
        `<h1>Sketch</h1>
<button id="export" type="button">Export as WebP</button>
<p id="download">Not exported yet</p>
<canvas id="canvas" width="${WIDTH}" height="${HEIGHT}" style="width: 400px; height: 250px; display: block;"></canvas>
<script>
    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, canvas.height);
    let s = 1;
    for (let i = 0; i < img.data.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = (i & 3) === 3 ? 255 : s >> 23;
    }
    ctx.putImageData(img, 0, 0);
    // The link appears after the page's targets were collected, so the crawl never follows it.
    function showLink(href, bytes) {
      const a = document.createElement("a");
      a.href = href;
      a.download = "sketch.webp";
      a.textContent = "Download (" + Math.round(bytes / 1024) + " KB)";
      document.getElementById("download").replaceChildren(a);
    }
    ${exporters[variant]}
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "cpu.blockingMs",
    direction: "lower",
    // slow: one ~420 ms task (the encode); fixed: 0 (the pixels are copied
    // out in a few ms, the encode runs on another thread).
    minImprovement: { ratio: 5, absolute: 100 },
  },
});
