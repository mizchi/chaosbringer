/**
 * Optimistic UI — the screen must never outrun the server.
 *
 * An optimistic update is a bet: the row appears before anything is committed,
 * and the app owes the user a correction if the bet loses. The interesting
 * failure is not "the write failed" — it is that the app cannot tell *what*
 * failed. A connection that never reached the server and a response body that
 * could not be read look identical from the `catch`, and they need opposite
 * corrections: drop the row in the first case, keep it in the second.
 *
 * So the contract is not "roll back on error". It is: never show a state you
 * have not verified. After an ambiguous failure the app re-reads the list and
 * renders what the server actually has, whatever that turns out to be.
 *
 * Divergence (window.__NOTES_FIXED__, from the FIXED env var):
 *   fixed  the catch re-reads the list and renders server truth.
 *   buggy  the catch swaps the banner and nothing else — and it clears the
 *          pending flag, so the row it never saved renders as a saved one.
 *          The user closes the tab believing the note is there.
 */
const FIXED = window.__NOTES_FIXED__ === true;
const SESSION = window.__SESSION__;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const list = document.getElementById("notes");
const input = document.getElementById("text");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function render(notes) {
  list.innerHTML = "";
  for (const note of notes) {
    const li = document.createElement("li");
    li.textContent = note.text;
    li.dataset.id = note.id;
    list.appendChild(li);
  }
}

/** Read the list the server actually has. Occurrence 0 is this page load. */
async function readList() {
  const res = await fetch(`/api/notes?session=${encodeURIComponent(SESSION)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  render(data.notes);
}

async function add() {
  const text = input.value.trim();
  if (text === "") return;

  // The bet: the row is on screen before the request leaves.
  const optimistic = document.createElement("li");
  optimistic.textContent = text;
  optimistic.dataset.pending = "1";
  list.appendChild(optimistic);
  setState("saving", "Saving…");

  try {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session": SESSION },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // A body that fails to read is a write that may well have committed.
    const data = await res.json();
    optimistic.dataset.id = data.id;
    delete optimistic.dataset.pending;
    setState("saved", "Saved.");
  } catch (err) {
    if (FIXED) {
      // We do not know whether the server committed, so ask it. This is the
      // whole pattern: one extra GET buys a screen that is true.
      await readList();
    } else {
      // The row stays, and stops looking provisional. Nothing here is a lie
      // the code can see — which is why review misses it.
      delete optimistic.dataset.pending;
    }
    setState("error", `Could not confirm the save: ${err.message}`);
  }
}

document.getElementById("add").addEventListener("click", () => {
  void add();
});

// The page load's own read. Handled like everything else — a model that
// forbids escaping rejections has to be able to trust the page it loads.
void readList().catch((err) => {
  setState("error", `Could not load your notes: ${err.message}`);
});
