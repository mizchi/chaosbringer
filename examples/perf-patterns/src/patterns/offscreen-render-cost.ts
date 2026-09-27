import { definePattern, html, page, type Variant } from "../pattern.js";

const SECTIONS = 200;

// A long docs page: 200 sections, each a heading, a few paragraphs, a table
// and a list. One screen shows the first two. The slow page makes the
// browser style and lay out all 200 on load. The fixed page marks each
// section `content-visibility: auto` with an estimated size, so the browser
// skips the layout of sections far from the viewport until they scroll near.
const sectionCss: Record<Variant, string> = {
  slow: "",
  fixed: "content-visibility: auto; contain-intrinsic-size: auto 900px;",
};

const section = (i: number) => `<section>
<h2>${i + 1}. Configuration option group ${i + 1}</h2>
${Array.from({ length: 3 }, (_, p) => `<p>Paragraph ${p + 1}: the <code>option${i}_${p}</code> setting controls how the service <em>retries</em>, <strong>caches</strong> and logs requests for this group; see the table below for the defaults.</p>`).join("\n")}
<table><thead><tr><th>Key</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>
${Array.from({ length: 8 }, (_, r) => `<tr><td><code>group${i}.key${r}</code></td><td>number</td><td>${(i * 13 + r * 7) % 100}</td><td>Tunes part ${r + 1} of group ${i + 1}.</td></tr>`).join("")}
</tbody></table>
<ul>${Array.from({ length: 5 }, (_, l) => `<li>Note ${l + 1} for group ${i + 1}</li>`).join("")}</ul>
</section>`;

export default definePattern({
  id: "offscreen-render-cost",
  title: "Rendering a long page's offscreen content",
  category: "render",
  description: `A ${SECTIONS}-section docs page renders every section on load, although a screen shows the first two. The browser lays out all ${SECTIONS} sections (their text, tables and lists) before the first frame, and the work grows with the page length, not with what is visible.`,
  fix: "Put content-visibility: auto (with contain-intrinsic-size: auto <estimate>) on the page's large independent sections, so offscreen ones skip layout and paint until they scroll near; or paginate / virtualise.",
  routes: (variant) => ({
    "/": html(
      page(
        "Reference",
        `<h1>Configuration reference</h1>
${Array.from({ length: SECTIONS }, (_, i) => section(i)).join("\n")}`,
        `<style>
  body { margin: 0; padding: 0 16px; font: 15px/1.5 system-ui, sans-serif; }
  section { ${sectionCss[variant]} border-bottom: 1px solid #ddd; padding-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ddd; padding: 2px 6px; text-align: left; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "render.layoutMs",
    direction: "lower",
    // slow: ~165 ms laying out all 200 sections; fixed: ~12 ms (the ones near the viewport).
    minImprovement: { ratio: 4, absolute: 50 },
  },
});
