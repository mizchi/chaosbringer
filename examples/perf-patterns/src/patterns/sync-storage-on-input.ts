import { definePattern, html, page, type Variant } from "../pattern.js";

const DRAFT = "Remember to rotate keys"; // 23 characters: 23 input events
const NOTES = 3000;

// A notes app keeps its whole state in one object: 3,000 saved notes (~1 MB
// as JSON) and the draft being typed. Both pages persist the draft to
// localStorage on every keystroke, so a reload never loses it. The slow page
// does it by serialising the whole state object and writing it under one
// key: every keystroke stringifies and stores ~1 MB, synchronously, on the
// main thread. The fixed page writes the draft under a key of its own (the
// saved notes are written when a note is saved, not while typing), so a
// keystroke stores a few dozen bytes.
//
// As in input-no-debounce, the crawler's fill() would fire one input event,
// so a "Type a note" button replays the keystrokes, one input event each.
const typer = `
    document.getElementById("type").addEventListener("click", () => {
      const box = document.getElementById("draft");
      box.value = "";
      for (const ch of ${JSON.stringify(DRAFT)}) {
        box.value += ch;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });`;

const persist: Record<Variant, string> = {
  slow: `
    document.getElementById("draft").addEventListener("input", (e) => {
      state.draft = e.target.value;
      localStorage.setItem("notes-app", JSON.stringify(state));
    });`,
  fixed: `
    document.getElementById("draft").addEventListener("input", (e) => {
      state.draft = e.target.value;
      localStorage.setItem("notes-app:draft", state.draft);
    });`,
};

export default definePattern({
  id: "sync-storage-on-input",
  title: "Whole state serialised to localStorage on every keystroke",
  category: "main-thread",
  description: `Typing in the note box costs a few milliseconds of main-thread time per keystroke, growing with the number of saved notes. To keep the draft across reloads, the input handler JSON.stringify()s the entire app state (${NOTES.toLocaleString("en-US")} notes, ~1 MB) and writes it to localStorage, which is synchronous; one changed character re-serialises and re-stores everything.`,
  fix: "Persist only what changed, under its own key (the draft alone), and write the rest when it changes; debounce or move large writes to idle time, or use IndexedDB (asynchronous) for big state.",
  routes: (variant) => ({
    "/": html(
      page(
        "Notes",
        `<h1>Notes</h1>
<textarea id="draft" rows="3" cols="40" placeholder="New note"></textarea>
<button id="type" type="button">Type a note</button>
<script>
    const state = {
      draft: "",
      notes: Array.from({ length: ${NOTES} }, (_, i) => ({
        id: i + 1,
        title: "Note " + (i + 1),
        body: "Meeting notes for item " + i + ": follow up with the platform team about the rollout schedule and the open questions from review.",
        tags: ["work", "q" + (i % 4 + 1)],
        updatedAt: 1700000000000 + i * 60000,
      })),
    };
    ${persist[variant]}
    ${typer}
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Only the button: a fill on the box would be one input event (see above).
    actionWeights: { scroll: 0, inputs: 0 },
  },
  expect: {
    key: "/ :: click *",
    // JS time: 23 × (stringify ~1 MB + setItem) against 23 tiny writes. It
    // scales smoothly with the work, unlike blockingMs.
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~115 ms a burst (23 × ~5 ms); fixed: ~2 ms.
    minImprovement: { ratio: 5, absolute: 30 },
  },
});
