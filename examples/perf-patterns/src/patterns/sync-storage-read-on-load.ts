import { definePattern, html, page, type Variant } from "../pattern.js";

const MESSAGES = 10000;
const FIRST_VIEW = 20;

// A mail client caches the whole inbox for offline use. The crawl's first
// page (/) plays the previous visit: it writes the cache the way each
// variant's app does, then links to the app (/app), whose load is the step
// under test.
//
// The slow app keeps the cache as one JSON value in localStorage and, on
// load, JSON.parse()s all of it (~3 MB) before it renders the first
// screen: localStorage is synchronous, so the read and the parse block the
// main thread while the page starts. The fixed app keeps only the first
// screen's messages in localStorage and the rest in IndexedDB (asynchronous,
// read when the reader scrolls past the first screen), so its load parses
// twenty messages.
const seed: Record<Variant, string> = {
  slow: `localStorage.setItem("inbox", JSON.stringify(messages));`,
  fixed: `localStorage.setItem("inbox:first", JSON.stringify(messages.slice(0, ${FIRST_VIEW})));
      const open = indexedDB.open("mail", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("inbox");
      open.onsuccess = () => {
        const tx = open.result.transaction("inbox", "readwrite");
        tx.objectStore("inbox").put(messages, "all");
        tx.oncomplete = () => { document.getElementById("status").textContent = "cached"; };
      };`,
};

const read: Record<Variant, string> = {
  slow: `const inbox = JSON.parse(localStorage.getItem("inbox") || "[]");
    const first = inbox.slice(0, ${FIRST_VIEW});`,
  fixed: `const first = JSON.parse(localStorage.getItem("inbox:first") || "[]");`,
};

const MAKE_MESSAGES = `const messages = Array.from({ length: ${MESSAGES} }, (_, i) => ({
      id: i + 1,
      from: "sender" + (i % 97) + "@example.com",
      subject: "Re: rollout schedule, item " + i,
      preview: "Following up on the open questions from the review: the platform team can take the migration if we move the freeze by a week.",
      labels: ["inbox", i % 3 ? "work" : "team"],
      receivedAt: 1700000000000 - i * 60000,
      read: i % 4 === 0,
    }));`;

export default definePattern({
  id: "sync-storage-read-on-load",
  title: "Whole offline cache read from localStorage on load",
  category: "main-thread",
  description: `A mail client caches its inbox (${MESSAGES.toLocaleString("en-US")} messages, ~3 MB of JSON) in localStorage under one key, and on every load reads and JSON.parse()s all of it before it renders the first screen of ${FIRST_VIEW}. localStorage is synchronous, so the whole read and parse run on the main thread during start-up, and grow with the cache, not with what the screen shows.`,
  fix: "Keep localStorage for small values: store the first screen's data (or nothing) there, put large caches in IndexedDB (asynchronous, structured, no JSON round trip) or the Cache API, and read the rest after the first render or on demand.",
  routes: (variant) => ({
    "/": html(
      page(
        "Mail",
        `<h1>Mail</h1>
<p id="status">caching…</p>
<a href="/app">Open inbox</a>
<script>
    ${MAKE_MESSAGES}
    ${seed[variant]}
    if (${JSON.stringify(variant)} === "slow") document.getElementById("status").textContent = "cached";
</script>`,
      ),
    ),
    "/app": html(
      page(
        "Inbox",
        `<h1>Inbox</h1>
<ul id="list"></ul>
<script>
    ${read[variant]}
    document.getElementById("list").innerHTML = first.map((m) => "<li><b>" + m.from + "</b> " + m.subject + "</li>").join("");
</script>`,
      ),
    ),
  }),
  crawl: {
    // The seeding page, then the app it links to.
    maxPages: 2,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/app :: load",
    // JS time of the app's load: the getItem and JSON.parse run inside its
    // script. It stays under 50 ms, so cpu.blockingMs would read 0.
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~40 ms (read + parse ~3 MB); fixed: ~4 ms.
    minImprovement: { ratio: 4, absolute: 15 },
  },
});
