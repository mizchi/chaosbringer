import { definePattern, html, json, page, type Variant } from "../pattern.js";

// "Save" posts the draft and, while the request is in flight (~600 ms), slides
// an indeterminate progress bar back and forth with a JS rAF animation. The
// slow variant moves the bar with `left`: a geometry change, so every frame the
// browser lays the page out again. The fixed variant moves it with
// `transform`, which needs no layout. The request keeps the animation inside
// the click's span: adaptive settle waits for it, but not for rAF alone.
const steps: Record<Variant, string> = {
  slow: `bar.style.left = x.toFixed(1) + "%";`,
  fixed: `bar.style.transform = "translateX(" + (x * 4).toFixed(1) + "%)";`,
};

export default definePattern({
  id: "layout-animation",
  title: "Animating left instead of transform",
  category: "render",
  description:
    "The progress bar shown while saving stutters on a busy page. It moves by writing style.left every animation frame, and each geometry change forces a layout per frame (dozens during one save) instead of letting the compositor move it.",
  fix: "Animate transform (and opacity) only, e.g. translateX(), or use a CSS animation on transform.",
  routes: (variant) => ({
    "/": html(
      page(
        "Editor",
        `<h1>Editor</h1>
<button id="save" type="button">Save</button>
<div class="track"><div id="bar" class="bar" hidden></div></div>
<p id="status"></p>
<ul>${Array.from({ length: 100 }, (_, i) => `<li>Paragraph ${i + 1}: lorem ipsum dolor sit amet</li>`).join("")}</ul>
<script>
    const bar = document.getElementById("bar");
    document.getElementById("save").addEventListener("click", async () => {
      let running = true;
      bar.hidden = false;
      const start = performance.now();
      function frame(now) {
        if (!running) return;
        const x = 75 * (0.5 - 0.5 * Math.cos((now - start) / 150));
        ${steps[variant]}
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      try {
        const res = await fetch("/api/save", { method: "POST", body: "draft" });
        document.getElementById("status").textContent = res.ok ? "Saved" : "Save failed";
      } finally {
        running = false;
        bar.hidden = true;
      }
    });
</script>`,
        `<style>
  body { font: 14px/1.4 sans-serif; }
  .track { position: relative; height: 4px; width: 400px; background: #eee; overflow: hidden; }
  .bar { position: absolute; left: 0; top: 0; height: 4px; width: 25%; background: #36c; }
</style>`,
      ),
    ),
    "/api/save": json({ ok: true }, { delayMs: 600 }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "render.layoutCount",
    direction: "lower",
    // slow ~35 layouts a click (one per frame for 600 ms), fixed ~1–3.
    minImprovement: { ratio: 5, absolute: 15 },
  },
});
