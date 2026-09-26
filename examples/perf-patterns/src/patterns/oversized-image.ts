import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

const AVATARS = 8;
const SHOWN_PX = 128;
const ORIGINAL_PX = 1024;

// The slow grid points every 128×128 slot at the 1024×1024 original. The fixed
// one offers renditions sized for the slot with srcset (128 px at 1×, 256 px
// at 2×), and the browser picks the one for its display.
function avatarImg(variant: Variant, i: number): string {
  const src = (w: number) => `/img/avatar.png?u=${i}&amp;w=${w}`;
  const attrs = `width="${SHOWN_PX}" height="${SHOWN_PX}" alt="Member ${i + 1}"`;
  return variant === "slow"
    ? `<img src="/img/avatar.png?u=${i}" ${attrs}>`
    : `<img src="${src(SHOWN_PX)}" srcset="${src(SHOWN_PX)} 1x, ${src(2 * SHOWN_PX)} 2x" ${attrs}>`;
}

// Built once per (size, avatar) and reused across crawls.
const cache = new Map<string, Buffer>();
function avatar(size: number, n: number): Buffer {
  const k = `${size}:${n}`;
  let png = cache.get(k);
  if (!png) cache.set(k, (png = noisePng(size, n + 1)));
  return png;
}

export default definePattern({
  id: "oversized-image",
  title: "Oversized images for small slots",
  category: "network",
  description:
    "An avatar grid shows eight 128×128 images, but each is the 1024×1024 original: 64× the pixels the slot needs (16× on a 2× display), megabytes of download and decode for thumbnails. lightbringer flags each as oversized (intrinsic pixels ≥ 4× the slot's).",
  fix: "Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format.",
  routes: (variant) => ({
    "/": html(
      page(
        "Team",
        `<h1>Team</h1>
<div class="grid">${Array.from({ length: AVATARS }, (_, i) => avatarImg(variant, i)).join("\n")}</div>`,
        `<style>.grid { display: grid; grid-template-columns: repeat(4, ${SHOWN_PX}px); gap: 8px; }</style>`,
      ),
    ),
    "/img/avatar.png": handler((req, res) => {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const u = Number(q.get("u") ?? 0) % AVATARS;
      // A rendition server: `w` picks a resized copy; without it, the original.
      const w = Number(q.get("w"));
      const px = w === SHOWN_PX || w === 2 * SHOWN_PX ? w : ORIGINAL_PX;
      const png = avatar(px, u);
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
      res.end(png);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // The diagnosis: how many images lightbringer flags as oversized.
    metric: "page.media.oversizedCount",
    direction: "lower",
    // slow: all 8 (64× over-fetch each); fixed: none (the 1× rendition matches the slot).
    minImprovement: { absolute: 6 },
    alsoExpect: [
      {
        // The bytes it costs: slow 8 × ~3 MB; fixed 8 × ~50 KB (64× fewer pixels at 1×).
        metric: "network.encodedKB",
        direction: "lower",
        minImprovement: { ratio: 8, absolute: 5000 },
      },
    ],
  },
});
