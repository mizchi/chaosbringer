import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const SCRIPT_DELAY_MS = 400;

// A vendor script that only decorates the page once the DOM is there, so it
// works the same whether it runs in <head> or after parsing.
const VENDOR_JS = `(function () {
  function init() {
    document.getElementById("status").textContent = "vendor script ready";
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();`;

const scriptTag: Record<Variant, string> = {
  slow: `<script src="/static/vendor.js"></script>`,
  fixed: `<script src="/static/vendor.js" defer></script>`,
};

export default definePattern({
  id: "render-blocking-script",
  title: "Synchronous script in <head>",
  category: "network",
  description: `A classic <script src> in <head> stops the parser until the script has downloaded and run. The server takes ${SCRIPT_DELAY_MS} ms to send it, so for ${SCRIPT_DELAY_MS} ms the page is blank, although none of its content needs the script to show.`,
  fix: "Load scripts with defer (or async, or type=module) and keep only what the first paint needs inline; for CSS, media queries or preload + swap for the non-critical part.",
  routes: (variant) => ({
    "/": html(
      page(
        "Home",
        `<h1>Welcome</h1>
<p>Everything on this page is plain HTML: it could paint as soon as it arrives.</p>
<p id="status">waiting for the vendor script…</p>`,
        scriptTag[variant],
      ),
    ),
    "/static/vendor.js": handler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, SCRIPT_DELAY_MS));
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(VENDOR_JS);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.vitals.FCP.value",
    direction: "lower",
    // slow: first paint waits for the 400 ms script; fixed: paints as soon as the HTML is parsed.
    minImprovement: { ratio: 2.5, absolute: 250 },
    alsoExpect: [
      {
        // lightbringer's render-blocking list: the one sync script, gone with defer
        // (perfPage leaves renderBlocking out when nothing blocks, hence absentAs).
        metric: "page.renderBlocking.scripts",
        direction: "lower",
        minImprovement: { absolute: 1 },
        absentAs: 0,
      },
    ],
  },
});
