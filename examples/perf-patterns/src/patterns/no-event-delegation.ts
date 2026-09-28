import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 5000;

// A contacts list of 5,000 rows, each with a "star" control. Both pages
// render the same rows on load and do the same thing on a click (toggle the
// star). The slow page wires the behaviour row by row: each row gets its own
// click listener, a fresh closure over that row's contact, as a naive
// component would. The fixed page puts one listener on the list and finds
// the row from the event target (event delegation), reading the id from a
// data attribute.
const wiring: Record<Variant, string> = {
  slow: `
    for (const [i, li] of [...list.children].entries()) {
      const contact = contacts[i];
      li.addEventListener("click", () => toggle(li, contact));
    }`,
  fixed: `
    list.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li) toggle(li, contacts[li.dataset.id - 1]);
    });`,
};

export default definePattern({
  id: "no-event-delegation",
  title: "One event listener per row instead of a delegated one",
  category: "memory",
  description: `The contacts page attaches a click listener to each of its ${ROWS.toLocaleString("en-US")} rows on load. Every listener is a separate closure and a separate registration the browser keeps for the node, so the page pays for ${ROWS.toLocaleString("en-US")} of them in load-time script and memory, and re-rendering the list has to wire them all again, although one handler on the list could serve every row.`,
  fix: "Delegate: one listener on the container that finds the row with event.target.closest() and reads its id from a data attribute (frameworks such as React already delegate at the root).",
  routes: (variant) => ({
    "/": html(
      page(
        "Contacts",
        `<h1>Contacts</h1>
<ul id="list"></ul>
<script>
    const contacts = Array.from({ length: ${ROWS} }, (_, i) => ({ id: i + 1, name: "Contact " + (i + 1), starred: false }));
    const list = document.getElementById("list");
    list.innerHTML = contacts.map((c) => '<li data-id="' + c.id + '"><span class="star">☆</span> ' + c.name + '</li>').join("");
    function toggle(li, contact) {
      contact.starred = !contact.starred;
      li.firstChild.textContent = contact.starred ? "★" : "☆";
    }
    ${wiring[variant]}
</script>`,
        `<style>
  body { font: 14px/1.4 system-ui, sans-serif; }
  #list { list-style: none; padding: 0; }
  #list li { padding: 2px 0; cursor: pointer; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    // The load is the step under test.
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // The page's live listener count at the end of the load: an exact
    // count, the same on every machine.
    metric: "memory.jsEventListeners",
    direction: "lower",
    // slow: ~5,000 (one per row); fixed: a handful.
    minImprovement: { ratio: 20, absolute: 4000 },
  },
});
