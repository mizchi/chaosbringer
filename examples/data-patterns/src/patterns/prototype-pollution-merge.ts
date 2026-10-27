import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages lay the user's saved preferences over the defaults with a
// recursive merge. The buggy merge follows every key it is given, so an own
// `__proto__` key (JSON.parse keeps it as an ordinary key) reads back
// Object.prototype as the object to merge into. The fixed merge walks own
// keys only and skips the three that lead to a prototype.
const merge: Record<Variant, string> = {
  buggy: `
    function merge(target, source) {
      for (const key in source) {
        const value = source[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (!target[key] || typeof target[key] !== "object") target[key] = {};
          merge(target[key], value);
        } else {
          target[key] = value;
        }
      }
      return target;
    }`,
  fixed: `
    const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    function merge(target, source) {
      for (const key of Object.keys(source)) {
        if (UNSAFE_KEYS.has(key)) continue;
        const value = source[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (!target[key] || typeof target[key] !== "object") target[key] = {};
          merge(target[key], value);
        } else {
          target[key] = value;
        }
      }
      return target;
    }`,
};

export default definePattern({
  id: "prototype-pollution-merge",
  title: "A deep merge that follows a __proto__ key",
  category: "malicious-data",
  description:
    "The preferences page deep-merges the user's saved settings over the defaults with a hand-written recursive merge. The settings are JSON the user wrote, and JSON.parse keeps a \"__proto__\" key as an ordinary own key, so the merge reads target.__proto__ (Object.prototype), sees an object, and copies the attacker's keys onto it. Every object on the page now inherits them: an isAdmin or a template option the code never set.",
  fix: "Merge own keys only (Object.keys, not for…in) and skip __proto__, constructor and prototype, as patched merge libraries do; or merge into null-prototype objects (Object.create(null)).",
  realism:
    "Settings, feature flags and CMS blocks stored as user-supplied JSON and merged client-side with lodash.merge, $.extend(true, …) or a home-grown deepMerge (CVE-2018-3721, CVE-2019-11358).",
  routes: (variant) => ({
    "/": html(
      page(
        "Preferences",
        `<h1>Preferences</h1>
<p id="summary">Loading…</p>
<script>
    const DEFAULTS = { theme: "light", editor: { fontSize: 14, tabSize: 2 } };${merge[variant]}
    async function load() {
      const res = await fetch("/api/preferences");
      const prefs = merge(structuredClone(DEFAULTS), await res.json());
      document.getElementById("summary").textContent =
        "Theme: " + prefs.theme + ", font size " + prefs.editor.fontSize + ", tab size " + prefs.editor.tabSize;
    }
    load();
</script>`,
      ),
    ),
    "/api/preferences": json({ theme: "dark" }),
  }),
  inject: {
    channel: "response",
    path: "/api/preferences",
    // A string, not an object: `__proto__` in an object literal sets the
    // prototype instead of adding a key, so the key would never be sent.
    bad: '{"theme":"dark","__proto__":{"cbPolluted":"1"}}',
    benign: '{"theme":"dark"}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.prototype-pollution" },
  },
});
