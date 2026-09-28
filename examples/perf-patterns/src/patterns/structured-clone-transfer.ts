import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const SIZE_MB = 64;

// An image editor keeps the decoded picture in one ArrayBuffer (RGBA
// pixels) and hands it to a Web Worker for each filter pass; the worker
// sends the result back. postMessage(buf) *copies* the buffer: the sending
// thread serialises every byte (a structured clone), and the receiving side
// allocates and fills a new one. So each filter costs the main thread two
// full copies of the image, one to send and one to take the result back. The
// fixed page lists the buffer in postMessage's transfer list (and the worker
// does the same on the way back): ownership moves to the other thread, and no
// byte is copied.
const post: Record<Variant, { main: string; worker: string }> = {
  slow: {
    main: `worker.postMessage({ pixels });`,
    worker: `self.postMessage({ pixels });`,
  },
  fixed: {
    main: `worker.postMessage({ pixels }, [pixels]);`,
    worker: `self.postMessage({ pixels }, [pixels]);`,
  },
};

const workerJs = (variant: Variant) => `
self.onmessage = (e) => {
  const pixels = e.data.pixels;
  // The "filter": invert one pixel in every 4096 (cheap on purpose; the
  // pattern is about moving the buffer, not the work).
  const px = new Uint8Array(pixels);
  for (let i = 0; i < px.length; i += 16384) px[i] = 255 - px[i];
  ${post[variant].worker}
};`;

export default definePattern({
  id: "structured-clone-transfer",
  title: "Large ArrayBuffer copied to a worker instead of transferred",
  category: "main-thread",
  description: `Each click on "Apply filter" sends the editor's ${SIZE_MB} MB pixel buffer to a Web Worker and takes the result back. postMessage copies an ArrayBuffer unless it is listed as transferable, so the main thread serialises all ${SIZE_MB} MB on the way out and deserialises another ${SIZE_MB} MB when the result comes back, although offloading to the worker was meant to keep that thread free.`,
  fix: "Transfer large buffers instead of copying them: postMessage(msg, [buffer]) (and the same on the reply), or structuredClone(value, { transfer }); share a SharedArrayBuffer when both sides must see the data at once (needs cross-origin isolation).",
  routes: (variant) => ({
    "/": html(
      page(
        "Editor",
        `<h1>Photo editor</h1>
<button id="apply" type="button">Apply filter</button>
<p id="out"></p>
<script>
    let pixels = new ArrayBuffer(${SIZE_MB} * 1024 * 1024);
    let passes = 0;
    // A transferred buffer is detached (0 bytes) here until the worker sends
    // it back; a click meanwhile waits for it rather than post an empty one.
    let queued = 0;
    const worker = new Worker("/js/filter-worker.js");
    function apply() {
      if (pixels.byteLength === 0) return void queued++;
      document.getElementById("out").textContent = "Applying…";
      ${post[variant].main}
    }
    worker.onmessage = (e) => {
      pixels = e.data.pixels;
      document.getElementById("out").textContent = "Filter passes: " + ++passes;
      if (queued) { queued--; apply(); }
    };
    document.getElementById("apply").addEventListener("click", apply);
</script>`,
      ),
    ),
    "/js/filter-worker.js": handler((_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(workerJs(variant));
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // Main-thread JS time, which includes postMessage's serialisation and the
    // reply's deserialisation (the worker's own copy is on its thread and not
    // measured). The click makes no request, so its span can close before a
    // slow reply lands (the reply's copy then counts in the next span, or in
    // none); the send's copy is always in the click's own span. cpu.blockingMs would read 0 for a copy that stays under 50 ms.
    metric: "render.scriptMs",
    direction: "lower",
    // slow: two 64 MB copies a click, ~50 ms (45–340 ms: fresh pages and GC
    // of the dropped copies vary it); fixed: ~3 ms.
    minImprovement: { ratio: 4, absolute: 20 },
  },
});
