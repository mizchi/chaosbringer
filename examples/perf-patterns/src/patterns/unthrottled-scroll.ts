import { definePattern, html, page, type Variant } from "../pattern.js";

const CARDS = 200;
// Scroll positions the "Skim the feed" button replays, one scroll event each.
const STEPS = 120;

const cards = Array.from(
  { length: CARDS },
  (_, i) => `<article class="card"><h2>Post ${i + 1}</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p></article>`,
).join("\n");

// The crawler's own scroll action is a single window.scrollTo, which fires one
// scroll event. A user's scroll (or a trackpad fling) fires many, so the page
// has a "Skim the feed" button that replays STEPS scroll positions in one
// task, dispatching a scroll event after each, as a burst of scroll input.
const skim = `
    document.getElementById("skim").addEventListener("click", () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      for (let i = 1; i <= ${STEPS}; i++) {
        window.scrollTo(0, Math.round((max * i) / ${STEPS}));
        window.dispatchEvent(new Event("scroll"));
      }
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event("scroll"));
    });`;

// Both variants keep a reading-progress bar in sync with the scroll position
// and mark the cards that have entered the viewport.
const handlers: Record<Variant, string> = {
  // Runs the whole update on every scroll event: it reads scrollHeight and
  // every card's position, and writes the bar's width. The write leaves layout
  // dirty, so the next event's first read (or scroll) forces a synchronous
  // layout of the whole feed: one per event.
  slow: `${skim}
    const bar = document.getElementById("bar");
    const cards = [...document.querySelectorAll(".card")];
    window.addEventListener("scroll", () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.width = ((scrollY / max) * 100).toFixed(2) + "%";
      for (const card of cards) {
        if (card.getBoundingClientRect().top < innerHeight) card.classList.add("seen");
      }
    });`,
  // A passive listener that only records that a frame is needed; the bar is
  // updated once per animation frame, and an IntersectionObserver marks the
  // cards, with no layout reads in script at all.
  fixed: `${skim}
    const bar = document.getElementById("bar");
    let queued = false;
    window.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const max = document.documentElement.scrollHeight - innerHeight;
        bar.style.width = ((scrollY / max) * 100).toFixed(2) + "%";
      });
    }, { passive: true });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("seen"); io.unobserve(e.target); }
    });
    document.querySelectorAll(".card").forEach((c) => io.observe(c));`,
};

export default definePattern({
  id: "unthrottled-scroll",
  title: "Layout reads in an unthrottled scroll handler",
  category: "main-thread",
  description:
    "Scrolling the feed stutters. The scroll handler runs its full update on every scroll event: it reads scrollHeight and every card's getBoundingClientRect() and writes the progress bar's width, so each event forces a synchronous layout of the whole feed.",
  fix: "Use a passive listener that coalesces to one requestAnimationFrame update, and an IntersectionObserver for visibility.",
  routes: (variant) => ({
    "/": html(
      page(
        "Feed",
        `<div id="bar"></div>
<h1>Feed</h1>
<button id="skim" type="button">Skim the feed</button>
<main id="feed">${cards}</main>
<script>${handlers[variant]}</script>`,
        `<style>
#bar { position: fixed; top: 0; left: 0; height: 4px; width: 0; background: #36c; }
.card { margin: 8px 0; padding: 8px 12px; border: 1px solid #ddd; font: 14px/1.4 sans-serif; }
.card.seen { border-color: #36c; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Only the button (the crawler's own scroll is one event; see above).
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "render.layoutCount",
    direction: "lower",
    // slow: one or more forced layouts per event (~120+); fixed: a handful.
    minImprovement: { ratio: 10, absolute: 60 },
  },
});
