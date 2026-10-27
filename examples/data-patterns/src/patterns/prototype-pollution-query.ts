import { definePattern, html, page, type Variant } from "../pattern.js";

// Both pages read nested settings from the query string in bracket notation,
// `?theme[color]=dark` → { theme: { color: "dark" } }, with the same parser.
// The buggy parser builds plain objects, where a `__proto__` segment reads
// back Object.prototype and the next segment is written onto it. The fixed
// parser builds null-prototype objects, where `__proto__` is an ordinary key.
const newNode: Record<Variant, string> = {
  buggy: "{}",
  fixed: "Object.create(null)",
};

export default definePattern({
  id: "prototype-pollution-query",
  title: "A bracket-notation query parser that walks into Object.prototype",
  category: "malicious-data",
  description:
    "The settings page parses ?theme[color]=dark into nested objects with a small hand-written parser that walks one object per bracket segment. For ?__proto__[cbPolluted]=1 the first step reads result.__proto__, which on a plain object is Object.prototype, so the value lands there: one crafted link pollutes every object on the page.",
  fix: "Build the parsed result from null-prototype objects (Object.create(null)) or a Map, or skip any segment that names an Object.prototype property (__proto__, constructor), as qs does by default.",
  realism:
    "Filter, search and settings pages that accept nested query parameters through a home-grown parser or a deparam-style plugin (jQuery BBQ's $.deparam and the parsers copied from it had this bug).",
  routes: (variant) => ({
    "/settings": html(
      page(
        "Settings",
        `<h1>Settings</h1>
<p id="summary">Loading…</p>
<script>
    function parseQuery(search) {
      const result = ${newNode[variant]};
      for (const [name, value] of new URLSearchParams(search)) {
        const path = name.replace(/\\]/g, "").split("[");
        let node = result;
        for (const key of path.slice(0, -1)) {
          if (!node[key] || typeof node[key] !== "object") node[key] = ${newNode[variant]};
          node = node[key];
        }
        node[path[path.length - 1]] = value;
      }
      return result;
    }
    const settings = parseQuery(location.search);
    document.getElementById("summary").textContent = "Theme color: " + (settings.theme?.color ?? "default");
</script>`,
      ),
    ),
  }),
  inject: {
    channel: "query",
    bad: "?__proto__%5BcbPolluted%5D=1",
    benign: "?theme%5Bcolor%5D=dark",
  },
  crawl: { entry: "/settings" },
  expect: {
    signal: { kind: "invariant", name: "data.prototype-pollution", message: /cbPolluted/ },
  },
});
