import { definePattern, html, page, type Variant } from "../pattern.js";

// Both pages read saved preferences from localStorage when the button is
// clicked. The buggy page trusts the stored string to be JSON; the fixed one
// falls back to the defaults when it can't be read.
const readPrefs: Record<Variant, string> = {
  buggy: `
    function readPrefs() {
      return JSON.parse(localStorage.getItem("prefs") ?? "{}");
    }`,
  fixed: `
    function readPrefs() {
      try {
        const prefs = JSON.parse(localStorage.getItem("prefs") ?? "{}");
        return prefs !== null && typeof prefs === "object" ? prefs : {};
      } catch {
        // Unreadable (a partial write, an older format): start from the defaults.
        return {};
      }
    }`,
};

export default definePattern({
  id: "corrupted-storage",
  title: "Stored preferences parsed as if they were always valid JSON",
  category: "bug-data",
  description:
    "The settings page restores the user's saved theme from localStorage with JSON.parse when the button is clicked. Storage outlives the code that wrote it: a value cut short by a crash mid-write, written by an older version, or edited by hand ({bad) makes JSON.parse throw inside the click handler, and the button does nothing.",
  fix: "Parse stored values defensively: catch the parse error, check the result's shape, and fall back to the defaults.",
  realism: "Values written by an older release in another format, a write cut short by a crash or a full quota, extensions and users editing storage, another app on the same origin using the same key.",
  routes: (variant) => ({
    "/": html(
      page(
        "Settings",
        `<h1>Settings</h1>
<p id="theme">Theme: light</p>
<button id="restore" type="button">Restore saved preferences</button>
<script>
    const themeEl = document.getElementById("theme");${readPrefs[variant]}
    document.getElementById("restore").addEventListener("click", () => {
      const prefs = readPrefs();
      const theme = typeof prefs.theme === "string" ? prefs.theme : "light";
      document.body.dataset.theme = theme;
      themeEl.textContent = "Theme: " + theme;
    });
</script>`,
      ),
    ),
  }),
  inject: {
    channel: "storage",
    key: "prefs",
    bad: "{bad",
    benign: '{"theme":"dark"}',
  },
  crawl: {
    maxActionsPerPage: 2,
    actionWeights: { scroll: 0 },
  },
  expect: {
    signal: { kind: "error", message: /JSON/ },
  },
});
