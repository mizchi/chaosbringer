import { definePattern, html, page, type Variant } from "../pattern.js";

const SECTIONS = 40;
// Work per update: find the section in view by walking a precomputed table
// of section offsets at a fine resolution (the stand-in for a scroll-spy's
// or a parallax effect's per-frame bookkeeping). Counted in iterations, so a
// slower machine does more wall-clock work, never less.
const STEPS = 400_000;

// A docs page with a scroll-progress bar and a "you are here" marker. Both
// pages compute them with the same update(). The slow page drives update()
// from a requestAnimationFrame loop that starts on load and never stops: it
// runs every frame (60 times a second) whether or not anything scrolled,
// even while the page just sits there. The fixed page runs update() in one
// rAF scheduled by a scroll (or resize) event, so an idle page does no work.
const driver: Record<Variant, string> = {
  slow: `
    function loop() {
      update();
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);`,
  fixed: `
    let queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; update(); });
    }
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    schedule();`,
};

export default definePattern({
  id: "idle-raf-loop",
  title: "requestAnimationFrame loop that runs while idle",
  category: "main-thread",
  description: `The page updates its scroll-progress bar and "you are here" marker from a requestAnimationFrame loop started on load. The loop re-runs its bookkeeping every frame, 60 times a second, for as long as the tab is open, although the values only change when the reader scrolls: an idle page burns CPU (and battery) and every frame has less room for real work.`,
  fix: "Drive the update from the event that changes its input (a scroll or resize listener that schedules one rAF), or an IntersectionObserver; run a rAF loop only while something animates, and stop it when it is done.",
  routes: (variant) => ({
    "/": html(
      page(
        "Guide",
        `<div id="bar"></div>
<nav id="here"></nav>
<h1>Operator guide</h1>
${Array.from({ length: SECTIONS }, (_, i) => `<section><h2>Chapter ${i + 1}</h2><p>Chapter ${i + 1} walks through one part of running the service in production, from the first deploy to the on-call rotation.</p></section>`).join("\n")}
<script>
    const sections = [...document.querySelectorAll("section")];
    const offsets = sections.map((s) => s.offsetTop);
    let last = -1;
    function update() {
      const y = scrollY;
      let active = 0;
      for (let k = 0; k < ${STEPS}; k++) {
        const i = k % offsets.length;
        if (offsets[i] <= y + (k & 7)) active = i;
      }
      const pct = Math.round((y / Math.max(1, document.documentElement.scrollHeight - innerHeight)) * 100);
      if (pct * 100 + active !== last) {
        last = pct * 100 + active;
        document.getElementById("bar").style.width = pct + "%";
        document.getElementById("here").textContent = "Chapter " + (active + 1);
      }
    }
    ${driver[variant]}
</script>`,
        `<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 0 16px; }
  #bar { position: fixed; top: 0; left: 0; height: 4px; background: #36c; }
  #here { position: fixed; top: 8px; right: 16px; }
  section { min-height: 60vh; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    // No actions: the load is the step under test (an idle page), and the
    // loop's cost is counted over the load span's frames.
    maxActionsPerPage: 0,
    seed: 1,
    // Adaptive with a 1 s quiet window: the load span then lasts ~1 s
    // past the last request on both variants, some 60 frames of an idle page.
    // Under the default 100 ms window it holds only a few frames, and the
    // fixed page's one initial update is a third of the slow page's total.
    settle: 1000,
  },
  expect: {
    key: "/ :: load",
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~75 ms (~60 frames × ~1.2 ms); fixed: ~7 ms (the page script and one update).
    minImprovement: { ratio: 3, absolute: 25 },
  },
});
