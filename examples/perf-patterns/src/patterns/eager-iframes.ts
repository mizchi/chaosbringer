import { definePattern, handler, html, page, type Routes, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

const EMBEDS = 4;
const POSTER_PX = 280;
const PLAYER_KB = 150;
// Enough text to put the embeds beyond Chrome's lazy-iframe distance (a few thousand px below the viewport).
const PARAGRAPHS = 150;

const poster = noisePng(POSTER_PX, 5);
const playerJs = Buffer.from(`/*! player v9 */window.__player = ${JSON.stringify("p".repeat(PLAYER_KB * 1024))}.length;`);

// A long article with four video embeds near the end, each an <iframe> to the
// video host (another registrable domain). An embed is a whole document: its
// HTML, the host's player script (~150 KB) and a poster image (~230 KB).
// The slow page's iframes load with the page, so every visit downloads all
// four players although the reader sees the first screen only. The fixed
// page marks them loading="lazy": the browser fetches an iframe only when it
// comes near the viewport, and none of these is near it on load.
const lazy: Record<Variant, string> = { slow: "", fixed: ` loading="lazy"` };

const asset = (type: string, body: Buffer) =>
  handler((_req, res) => {
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
    res.end(body);
  });

export default definePattern({
  id: "eager-iframes",
  title: "Below-the-fold iframes loaded with the page",
  category: "network",
  description: `An article ends with ${EMBEDS} video embeds, far below the first screen. Each <iframe> is a full document from the video host: its HTML, a ~${PLAYER_KB} KB player script and a poster image. Without loading="lazy" the browser loads all of them with the page, so every visit downloads ~1.5 MB of third-party embeds that most readers never scroll to.`,
  fix: "Add loading=\"lazy\" to offscreen iframes (with width and height set), or show a facade (the poster and a play button) and create the iframe on click.",
  routes: (variant, { thirdPartyOrigin }) => ({
    "/": html(
      page(
        "Article",
        `<h1>Building the ridge station</h1>
${Array.from({ length: PARAGRAPHS }, (_, i) => `<p>Paragraph ${i + 1}. The team hauled the mast up in sections and anchored it against the wind before the first storm of the season.</p>`).join("\n")}
<h2>Videos</h2>
${Array.from({ length: EMBEDS }, (_, i) => `<iframe src="${thirdPartyOrigin}/embed/video?v=${i + 1}" width="560" height="315" title="Video ${i + 1}"${lazy[variant]}></iframe>`).join("\n")}`,
        `<style>body { font: 16px/1.6 system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 0 16px; } iframe { display: block; margin: 16px 0; border: 0; }</style>`,
      ),
    ),
  }),
  thirdPartyRoutes: (): Routes => ({
    "/embed/video": handler((req, res) => {
      const v = new URL(req.url ?? "/", "http://x").searchParams.get("v") ?? "1";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Video ${v}</title></head><body style="margin:0"><img src="/embed/poster.png?v=${v}" width="${POSTER_PX}" height="${POSTER_PX}" alt=""><script src="/embed/player.js?v=${v}"></script></body></html>`,
      );
    }),
    "/embed/player.js": asset("text/javascript; charset=utf-8", playerJs),
    "/embed/poster.png": asset("image/png", poster),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
    // External-navigation blocking (on by default) fails every document
    // request to another origin, iframes included: the embeds would never
    // load on either variant.
    options: { blockExternalNavigation: false },
  },
  expect: {
    key: "/ :: load",
    metric: "page.network.thirdParty.encodedKB",
    direction: "lower",
    absentAs: 0,
    // slow: ~1,480 KB from the video host; fixed: nothing on load.
    // perfPage leaves network.thirdParty out when there was no third-party request.
    minImprovement: { ratio: 5, absolute: 500 },
    alsoExpect: [
      {
        metric: "page.network.thirdParty.requestCount",
        direction: "lower",
        absentAs: 0,
        // slow: 4 × (document, player, poster); fixed: none.
        minImprovement: { absolute: 8 },
      },
    ],
  },
});
