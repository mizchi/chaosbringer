import { definePattern, html, page } from "../pattern.js";

// Every token renderedGarbage looks for is on this page, but only where a
// reader expects it: in code samples, in the output the page computes into
// <samp>, in a playground textarea, in text the reader hasn't opened, and
// inside longer words. The outputs are computed rather than typed in, so they
// are what this browser prints, and they land after load like any rendered
// value would.
const body = `<h1>Formatting missing values</h1>
<p>format() never prints a raw JavaScript value. These are the values it guards against, and what the language prints for each when nothing does:</p>
<table>
  <thead><tr><th scope="col">Expression</th><th scope="col">Prints</th></tr></thead>
  <tbody>
    <tr><td><code>({}).name</code></td><td><samp data-example="missing">…</samp></td></tr>
    <tr><td><code>Number("12,5")</code></td><td><samp data-example="comma">…</samp></td></tr>
    <tr><td><code>String({ a: 1 })</code></td><td><samp data-example="object">…</samp></td></tr>
    <tr><td><code>new Date("not-a-date")</code></td><td><samp data-example="date">…</samp></td></tr>
  </tbody>
</table>
<p>Arithmetic on a missing price returns <code>NaN</code>, and nothing throws:</p>
<pre><code>const total = price * qty;     // NaN when price is "12,5"
label.textContent = user.name; // "undefined" when the API left it out</code></pre>
<p>Try it in the console: <kbd>isNaN(undefined)</kbd> answers <samp>true</samp>.</p>
<label for="playground">Playground</label>
<textarea id="playground" rows="2" cols="60">format(undefined) // "–", not "undefined"
format(0 / 0)     // "–", not "NaN"</textarea>
<p>Set the undefinedBehavior option to "throw" to fail fast instead. format() tests Number.isFinite, not isNaN, so Infinity is caught too.</p>
<p><button type="button" id="show-answer">Show the answer</button> What does <code>"12,5" * 2</code> print?</p>
<p id="answer" hidden>It prints NaN: the comma isn't a decimal separator to JavaScript.</p>
<p>Before the first request resolves, <span class="term">user.name<span class="tip">is undefined until /api/user answers</span></span> is shown as a dash.</p>
<div class="tab-panel" style="display:none">In TypeScript this is a compile error, not undefined at runtime.</div>
<details><summary>Why not show a placeholder value?</summary><p>A placeholder that reads [object Object] or Invalid Date looks like data.</p></details>
<noscript>Enable JavaScript to see the live outputs; without it every example reads undefined.</noscript>
<script>
    const examples = {
      missing: () => ({}).name,
      comma: () => Number("12,5"),
      object: () => String({ a: 1 }),
      date: () => new Date("not-a-date"),
    };
    for (const el of document.querySelectorAll("samp[data-example]")) {
      el.textContent = String(examples[el.dataset.example]());
    }
    document.getElementById("show-answer").addEventListener("click", () => {
      document.getElementById("answer").hidden = false;
    });
</script>`;

export default definePattern({
  id: "oracle-code-sample",
  title: "Docs that print undefined and NaN on purpose",
  category: "oracle",
  description:
    "A docs page for a formatting helper shows what JavaScript prints for an unchecked value: undefined, NaN, [object Object] and Invalid Date, in code and pre blocks, in <samp> output the page computes on load, in a kbd console hint and a playground textarea, in an answer behind a button, a tooltip, a hidden tab and a closed <details>, and inside the words undefinedBehavior and isNaN. A check that matched the tokens anywhere in the text would flag every page that documents them.",
  fix: "Nothing to fix: renderedGarbage skips code, pre, kbd, samp and textarea, text the user can't see, and a token inside a longer word.",
  realism: "API references, tutorials and changelogs that explain NaN and undefined; playgrounds and REPL output on docs sites.",
  routes: () => ({
    "/": html(
      page(
        "Formatting missing values",
        body,
        "<style>.tip { visibility: hidden; margin-left: .5em } .term:hover .tip { visibility: visible }</style>",
      ),
    ),
  }),
  inject: { channel: "none" },
  expect: { signal: "none" },
});
