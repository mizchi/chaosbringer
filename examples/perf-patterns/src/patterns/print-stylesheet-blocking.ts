import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const CSS_DELAY_MS = 400;

// The print styles live in a stylesheet of their own, all inside
// @media print { ... }. The slow page links it as a plain stylesheet: the
// browser cannot know what is inside until it has downloaded it, so a
// <link rel=stylesheet> without a media attribute blocks first paint, and
// the screen waits ${CSS_DELAY_MS} ms for rules it never applies. The fixed
// page says so on the link, media="print": the browser still downloads it
// (at low priority) but does not wait for it to paint the screen.
const link: Record<Variant, string> = {
  slow: `<link rel="stylesheet" href="/css/print.css">`,
  fixed: `<link rel="stylesheet" href="/css/print.css" media="print">`,
};

const PRINT_CSS = `@media print {
  nav, .no-print { display: none; }
  body { font: 11pt/1.4 Georgia, serif; color: #000; }
  a[href]::after { content: " (" attr(href) ")"; }
}`;

export default definePattern({
  id: "print-stylesheet-blocking",
  title: "Print stylesheet linked without media=\"print\"",
  category: "network",
  description: `The site's print styles are a separate stylesheet whose rules are all inside @media print, linked with a plain <link rel=stylesheet>. The browser treats a stylesheet without a media attribute as needed for the screen, so first paint waits for its ${CSS_DELAY_MS} ms download, for rules that only apply on paper.`,
  fix: "Put the media query on the <link> (media=\"print\", or a min-width query for a breakpoint's sheet): the browser still fetches it, without blocking the screen's first paint; or fold small print rules into the main stylesheet.",
  routes: (variant) => ({
    "/": html(
      page(
        "Recipe",
        `<nav><a href="/">Home</a></nav>
<h1>Lentil soup</h1>
<p>Serves four. Rinse the lentils, sweat the onion, add stock and simmer for 25 minutes.</p>
<button class="no-print" type="button" onclick="print()">Print</button>`,
        `<style>body { margin: 0; padding: 0 16px; font: 16px/1.5 system-ui, sans-serif; }</style>
${link[variant]}`,
      ),
    ),
    "/css/print.css": handler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, CSS_DELAY_MS));
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      res.end(PRINT_CSS);
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
    minImprovement: { ratio: 2.5, absolute: 200 },
    alsoExpect: [
      {
        // lightbringer's render-blocking list: the print sheet, gone with
        // media="print" (perfPage leaves renderBlocking out when nothing blocks).
        metric: "page.renderBlocking.stylesheets",
        direction: "lower",
        minImprovement: { absolute: 1 },
        absentAs: 0,
      },
    ],
  },
});
