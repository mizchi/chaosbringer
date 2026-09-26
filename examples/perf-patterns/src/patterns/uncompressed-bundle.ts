import { gzipSync } from "node:zlib";
import { definePattern, handler, html, page, type Variant } from "../pattern.js";

// A ~300 KB bundle that looks like real code: many small, similar modules.
// Source code compresses well (5–10×), so this one does too.
function buildBundle(): string {
  const parts: string[] = ["(function(){", "var registry = {};"];
  let length = 0;
  for (let i = 0; length < 300_000; i++) {
    const lines = [
      `registry["module_${i}"] = function (props) {`,
      `  var label = "Component ${i}: " + (props && props.title ? props.title : "untitled");`,
      `  var items = (props && props.items) || [];`,
      `  return { id: ${i}, label: label, count: items.length, total: items.reduce(function (a, b) { return a + b; }, ${i % 17}) };`,
      `};`,
    ];
    parts.push(...lines);
    length += lines.join("\n").length + 1;
  }
  parts.push(
    `window.__bundle = { size: Object.keys(registry).length, first: registry.module_0({ title: "hi", items: [1, 2] }) };`,
    "})();",
  );
  return parts.join("\n");
}

const bundle = Buffer.from(buildBundle());
const bundleGz = gzipSync(bundle, { level: 9 });

export default definePattern({
  id: "uncompressed-bundle",
  title: "JavaScript served without compression",
  category: "network",
  description:
    "The page's ~300 KB script is sent as plain bytes. Text compresses 5–10× with gzip or brotli, so every visitor downloads several times more than necessary before the app can start.",
  fix: "Serve text assets compressed (Content-Encoding: gzip or br), at the server, CDN or build step.",
  routes: (variant) => ({
    "/": html(
      page(
        "App",
        `<h1>App</h1>
<p id="out">Loading…</p>
<script>document.getElementById("out").textContent = "modules: " + window.__bundle.size;</script>`,
        `<script src="/static/app.js"></script>`,
      ),
    ),
    "/static/app.js": handler((_req, res) => {
      const headers: Record<string, string | number> = {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      };
      if (variant === "fixed") {
        res.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": bundleGz.length, vary: "Accept-Encoding" });
        res.end(bundleGz);
      } else {
        res.writeHead(200, { ...headers, "content-length": bundle.length });
        res.end(bundle);
      }
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "network.encodedKB",
    direction: "lower",
    // slow: ~300 KB on the wire; fixed: the gzip of it (far smaller, see the test log).
    minImprovement: { ratio: 4, absolute: 200 },
  },
});
