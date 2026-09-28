import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const ITEMS = 600;

// A file browser: 600 rows, each with a file icon and a "share" icon. The
// icons are SVG drawings of four paths each. The slow page pastes the full
// <svg> markup into every row (what an icon component that returns its SVG
// inline renders), so the HTML carries 1,200 copies of the same path data
// and the DOM a full SVG subtree (an <svg> and four <path>s) per icon. The
// fixed page ships each icon once, as a small cacheable .svg file, and draws
// every copy as one empty element painted with a CSS mask in currentColor
// (so it still takes the text colour).
//
// Not a <symbol> sprite with <use href>: that saves the bytes, but every
// <use> instantiates a copy of its symbol in a shadow tree, so the DOM (and
// render.nodes, which counts those copies) ends up larger than the inline
// version's, and style recalc slower. See the README pitfall.
//
// The HTML here is served uncompressed. With gzip the repeated markup
// compresses well, so the wire gap shrinks; the node count does not.
const ICONS = {
  file: [
    "M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M14 2v6h6",
    "M8 13h8M8 17h8M8 9h2",
    "M9.5 20.5c1.2-.8 3.8-.8 5 0",
  ],
  share: [
    "M18 8a3 3 0 1 0-2.83-4H15a3 3 0 0 0 .17 1l-6.4 3.2A3 3 0 1 0 6 13a3 3 0 0 0 2.77-1.85l6.4 3.2A3 3 0 1 0 18 16",
    "M8.59 13.51l6.83 3.98",
    "M15.41 6.51l-6.82 3.98",
    "M3 21h18",
  ],
} as const;

type IconName = keyof typeof ICONS;

const paths = (name: IconName) => ICONS[name].map((d) => `<path d="${d}"/>`).join("");
const SVG_ATTRS = `width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

const icon: Record<Variant, (name: IconName) => string> = {
  slow: (name) => `<svg class="icon" ${SVG_ATTRS} aria-hidden="true">${paths(name)}</svg>`,
  fixed: (name) => `<i class="icon icon-${name}" aria-hidden="true"></i>`,
};

const iconFile = (name: IconName) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${SVG_ATTRS.replace("currentColor", "#000")}>${paths(name)}</svg>`;

const iconCss: Record<Variant, string> = {
  slow: "",
  fixed: `
  i.icon { display: inline-block; width: 20px; height: 20px; background: currentColor; mask: var(--icon) center / contain no-repeat; }
${(Object.keys(ICONS) as IconName[]).map((name) => `  .icon-${name} { --icon: url("/icons/${name}.svg"); }`).join("\n")}`,
};

export default definePattern({
  id: "inline-svg-icons",
  title: "The same SVG icon inlined hundreds of times",
  category: "render",
  description: `The file list's HTML is dominated by icons: each of its ${ITEMS} rows carries two icons as full inline <svg> markup, so the same path data is sent ${(ITEMS * 2).toLocaleString("en-US")} times and parsed into a separate SVG subtree (an <svg> and four <path>s) per icon, which the browser has to style, lay out and keep in memory, although the page uses only two distinct icons.`,
  fix: "Ship each icon once, as a cacheable file, and draw copies as one element each: a CSS mask-image over background: currentColor (keeps the text colour), or an <img>; an icon font does the same. A <use> sprite saves the bytes but not the DOM.",
  routes: (variant) => ({
    "/": html(
      page(
        "Files",
        `<h1>Files</h1>
<ul id="files">
${Array.from({ length: ITEMS }, (_, i) => `<li>${icon[variant]("file")} report-${i + 1}.pdf ${icon[variant]("share")}</li>`).join("\n")}
</ul>`,
        `<style>
  body { font: 14px/1.4 system-ui, sans-serif; }
  #files { list-style: none; padding: 0; }
  #files li { display: flex; align-items: center; gap: 6px; }
  .icon { flex: none; color: #456; }${iconCss[variant]}
</style>`,
      ),
    ),
    // Both variants serve the files (same paths); only the fixed page uses them.
    ...Object.fromEntries(
      (Object.keys(ICONS) as IconName[]).map((name) => [
        `/icons/${name}.svg`,
        handler((_req, res) => {
          res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" });
          res.end(iconFile(name));
        }),
      ]),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // Nodes the load added: an exact count.
    metric: "render.nodes",
    direction: "lower",
    // slow: ~7,800 (five SVG nodes per icon); fixed: ~3,000 (one element per icon).
    minImprovement: { ratio: 1.8, absolute: 3000 },
    alsoExpect: [
      {
        // The load's bytes: the document (and, on the fixed page, two tiny icon files).
        metric: "network.encodedKB",
        direction: "lower",
        // slow: ~450 KB of HTML; fixed: ~75 KB.
        minImprovement: { ratio: 3, absolute: 200 },
      },
    ],
  },
});
