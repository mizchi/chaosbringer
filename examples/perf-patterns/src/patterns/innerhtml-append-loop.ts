import { definePattern, html, page, type Variant } from "../pattern.js";

const COMMENTS = 500;

// "Show comments" renders the thread's comments into a list. The slow page
// appends each one with `list.innerHTML += html`: that is not an append but
// read-modify-write of the whole list. Each += serialises every row already
// there back to a string, then throws those nodes away and parses the
// longer string into new ones, so rendering n rows parses ~n²/2 rows' worth
// of HTML. The fixed page builds the rows' HTML first and inserts it once
// (one insertAdjacentHTML; a DocumentFragment or one innerHTML assignment is
// the same), parsing each row once. Style and layout run once at the end on
// both pages; the difference is all in the script.
const render: Record<Variant, string> = {
  slow: `list.innerHTML = "";
      for (const c of comments) list.innerHTML += row(c);`,
  fixed: `list.innerHTML = "";
      list.insertAdjacentHTML("beforeend", comments.map(row).join(""));`,
};

export default definePattern({
  id: "innerhtml-append-loop",
  title: "innerHTML += in a loop (quadratic re-parse)",
  category: "main-thread",
  description: `Clicking "Show comments" renders ${COMMENTS.toLocaleString("en-US")} comments with list.innerHTML += row inside a loop. Each += serialises the whole list to HTML, discards its nodes and parses it back with one more row, so the work grows with the square of the row count: the last append alone re-parses every comment before it, and the click freezes the page.`,
  fix: "Build the markup (or the nodes) first and insert once: join the rows' HTML and set it in one assignment or insertAdjacentHTML('beforeend', …), append nodes to a DocumentFragment, or let a framework render the list; never += on innerHTML in a loop.",
  routes: (variant) => ({
    "/": html(
      page(
        "Thread",
        `<h1>Release discussion</h1>
<button id="show" type="button">Show comments</button>
<ol id="list"></ol>
<script>
    const comments = Array.from({ length: ${COMMENTS} }, (_, i) => ({
      author: "user" + (i % 211),
      text: "Comment " + (i + 1) + ": the new build fixed the sync issue for me, but the export still times out on large projects.",
    }));
    const row = (c) => "<li><b>" + c.author + "</b> <span>" + c.text + "</span></li>";
    const list = document.getElementById("list");
    document.getElementById("show").addEventListener("click", () => {
      ${render[variant]}
    });
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // JS time, which includes the HTML parsing and serialising the setter does.
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~290 ms a click (~125,000 rows parsed); fixed: ~3 ms (500 rows, once).
    minImprovement: { ratio: 10, absolute: 100 },
  },
});
