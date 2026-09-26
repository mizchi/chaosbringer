import { definePattern, html, json, page, type Variant } from "../pattern.js";

const BANNER_PX = 250;

// Both variants put the same banner into the same slot when the ad response
// arrives, 300 ms after the page loaded. The slow slot is an empty div, so the
// banner pushes the whole article down; the fixed slot reserves the banner's
// height up front, so the banner fills space that was already there.
const slotCss: Record<Variant, string> = {
  slow: "",
  fixed: `min-height: ${BANNER_PX}px;`,
};

export default definePattern({
  id: "cls-late-content",
  title: "Late content inserted without reserved space",
  category: "render",
  description: `An ad slot above the article is an empty div until the ad response arrives (300 ms after load). Then a ${BANNER_PX} px banner appears in it and every line of the article the reader was looking at jumps down: a large layout shift, counted in CLS.`,
  fix: "Reserve the slot's space before the content arrives (min-height or aspect-ratio on the container, or a skeleton of the same size).",
  routes: (variant) => ({
    "/": html(
      page(
        "Article",
        `<header><strong>Daily News</strong></header>
<div id="ad-slot"></div>
<article>
<h1>Local team wins again</h1>
${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}. The match was decided in the last minutes, when the visitors lost the ball near their own box and the home side scored on the counter.</p>`).join("\n")}
</article>
<script>
  fetch("/api/ad").then((r) => r.json()).then((ad) => {
    const banner = document.createElement("div");
    banner.className = "banner";
    banner.textContent = ad.text;
    document.getElementById("ad-slot").appendChild(banner);
  });
</script>`,
        `<style>
  body { margin: 0; font: 18px/1.6 system-ui, sans-serif; }
  header, article { padding: 0 16px; }
  #ad-slot { ${slotCss[variant]} }
  .banner { height: ${BANNER_PX}px; background: #fde68a; display: grid; place-items: center; }
</style>`,
      ),
    ),
    "/api/ad": json({ text: "Advertisement" }, { delayMs: 300 }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.vitals.CLS.value",
    direction: "lower",
    // slow: the article (the whole viewport) moves 250 px, ~0.2 at a 1280 px wide
    // viewport (CLS divides the distance by the viewport's larger side); fixed: 0.
    minImprovement: { ratio: 5, absolute: 0.05 },
  },
});
