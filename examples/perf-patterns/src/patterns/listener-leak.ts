import { definePattern, html, page, type Variant } from "../pattern.js";

// A stock-ticker widget re-rendered by "Refresh widget". Each mount wires
// global listeners (resize, scroll, keydown, visibility, online/offline...)
// so the widget can react to the page. The slow variant never unmounts: the
// old listeners stay on window/document, still closing over the old widget's
// DOM, so every refresh leaks them. The fixed variant keeps the teardown
// function mount() returns and calls it before mounting again.
const GLOBAL_EVENTS = [
  ["window", "resize"],
  ["window", "scroll"],
  ["window", "focus"],
  ["window", "blur"],
  ["window", "online"],
  ["window", "offline"],
  ["window", "hashchange"],
  ["window", "popstate"],
  ["window", "message"],
  ["window", "storage"],
  ["document", "keydown"],
  ["document", "keyup"],
  ["document", "visibilitychange"],
  ["document", "pointerdown"],
  ["document", "pointermove"],
  ["document", "wheel"],
  ["document", "copy"],
  ["document", "selectionchange"],
  ["document", "click"],
  ["document", "contextmenu"],
];

const remount: Record<Variant, string> = {
  slow: `
    document.getElementById("refresh").addEventListener("click", () => {
      mount(document.getElementById("widget"));
    });`,
  fixed: `
    document.getElementById("refresh").addEventListener("click", () => {
      teardown();
      teardown = mount(document.getElementById("widget"));
    });`,
};

export default definePattern({
  id: "listener-leak",
  title: "Global listeners not removed on re-render",
  category: "memory",
  description:
    "Every \"Refresh widget\" click leaves 20 more event listeners on window and document. The widget adds global listeners on each mount and never removes them, so they pile up (and keep each old widget's DOM alive through their closures); a long session slows every event.",
  fix: "Return a teardown from mount (removeEventListener, or an AbortController signal) and call it before re-rendering.",
  routes: (variant) => ({
    "/": html(
      page(
        "Ticker",
        `<h1>Ticker</h1>
<button id="refresh" type="button">Refresh widget</button>
<div id="widget"></div>
<script>
    const EVENTS = ${JSON.stringify(GLOBAL_EVENTS)};
    let generation = 0;
    function mount(root) {
      const n = ++generation;
      root.innerHTML = '<div class="ticker"><b>ACME</b> <span class="price">' + (100 + n).toFixed(2) + '</span> <small class="last"></small></div>';
      const last = root.querySelector(".last");
      const onEvent = (e) => { last.textContent = "last event: " + e.type; };
      const bound = EVENTS.map(([target, type]) => {
        const t = target === "window" ? window : document;
        t.addEventListener(type, onEvent);
        return [t, type];
      });
      return () => { for (const [t, type] of bound) t.removeEventListener(type, onEvent); };
    }
    let teardown = mount(document.getElementById("widget"));
${remount[variant]}
</script>`,
        `<style>.ticker { font: 16px/1.4 monospace; padding: 8px; border: 1px solid #ddd; display: inline-block; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 6,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
    // Retained listeners only: GC at span boundaries so garbage does not count.
    perf: { memory: { forceGc: true } },
  },
  expect: {
    key: "/ :: click *",
    metric: "memory.listenersDelta",
    direction: "lower",
    // slow retains +20 listeners a click, fixed 0. Absolute only: a ratio
    // against a fixed median of 0 (or a stray -1) says nothing.
    minImprovement: { absolute: 15 },
  },
});
