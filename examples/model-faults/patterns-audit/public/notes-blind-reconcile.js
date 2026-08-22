/**
 * F1 — optimistic-rollback: the reconcile read that nobody reads.
 *
 * The shipped pattern's whole justification is that `expect.calls` separates an
 * app that *knows* from one that guessed right:
 *
 *   "What distinguishes it from an app that knows is a request — the reconcile
 *    read, and `--calls-var list=listCalls` lifts that count into
 *    `expect.calls`."                            (patterns/README.md)
 *
 * This page always issues that request and never uses the answer. It is the
 * shape you get from cache invalidation next to a local rollback — `void
 * refetch()`, `queryClient.invalidateQueries()`, a reconcile whose render sits
 * behind a stale-guard that is false — plus the case analysis every real app
 * writes sooner or later:
 *
 *   fetch threw            → the request never left  → drop the row
 *   !res.ok                → the server refused      → drop the row
 *   res.json() threw       → ambiguous               → keep the row
 *
 * That analysis is right three times out of four *by luck*, which is precisely
 * what the pattern says it exists to catch. Every count it produces is the
 * count a correct app produces: one page-load GET, one POST, one reconcile GET,
 * and `shown == committed` in every terminal state.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  the reconcile's answer is rendered; rows carry the server's ids.
 *   buggy  the answer is discarded and the local guess is promoted, under an
 *          id only this tab has ever heard of.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const SESSION = window.__SESSION__;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const list = document.getElementById("notes");
const input = document.getElementById("text");

let localSeq = 0;

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

async function readList() {
  const res = await fetch(`/api/notes?session=${encodeURIComponent(SESSION)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  render(data.notes);
}

/** Identical request, identical URL, identical count — the body goes nowhere. */
async function readListAndDiscard() {
  const res = await fetch(`/api/notes?session=${encodeURIComponent(SESSION)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
}

/** Promote the optimistic row without ever having read the server's version. */
function promoteLocally(li) {
  localSeq += 1;
  li.dataset.id = `local-${localSeq}`;
  delete li.dataset.pending;
}

async function add() {
  const text = input.value.trim();
  if (text === "") return;

  const optimistic = document.createElement("li");
  optimistic.textContent = text;
  optimistic.dataset.pending = "1";
  list.appendChild(optimistic);
  setState("saving", "Saving…");

  let res;
  try {
    res = await fetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session": SESSION },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    // Never left the tab. Nothing committed — and the refetch happens anyway,
    // because invalidating the cache is what the framework call does.
    if (FIXED) {
      await readList();
    } else {
      optimistic.remove();
      await readListAndDiscard();
    }
    setState("error", `Could not confirm the save: ${err.message}`);
    return;
  }

  if (!res.ok) {
    if (FIXED) {
      await readList();
    } else {
      optimistic.remove();
      await readListAndDiscard();
    }
    setState("error", `Could not confirm the save: HTTP ${res.status}`);
    return;
  }

  try {
    const data = await res.json();
    optimistic.dataset.id = data.id;
    delete optimistic.dataset.pending;
    setState("saved", "Saved.");
  } catch (err) {
    // The ambiguous one: the server took it, the reply did not come back. The
    // app asks… and then renders what it already believed.
    if (FIXED) {
      await readList();
    } else {
      await readListAndDiscard();
      promoteLocally(optimistic);
    }
    setState("error", `Could not confirm the save: ${err.message}`);
  }
}

document.getElementById("add").addEventListener("click", () => {
  void add();
});

void readList().catch((err) => {
  setState("error", `Could not load your notes: ${err.message}`);
});
