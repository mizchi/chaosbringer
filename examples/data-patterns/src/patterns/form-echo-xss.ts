import { definePattern, html, page, type Variant } from "../pattern.js";

// Both pages echo what you type into the guestbook back onto the page, the way
// an optimistic UI shows a comment before the server confirms it. The buggy
// page writes the value with innerHTML; the fixed one sets it as text.
const echo: Record<Variant, string> = {
  buggy: `
      preview.innerHTML = "You said: " + input.value;`,
  fixed: `
      preview.textContent = "You said: " + input.value;`,
};

export default definePattern({
  id: "form-echo-xss",
  title: "A form value echoed back with innerHTML",
  category: "malicious-data",
  description:
    "The guestbook shows an optimistic preview of your entry as you submit it, built with preview.innerHTML = \"You said: \" + value. The value is whatever was typed, so an entry that is markup runs as markup on submit: a <details open ontoggle> payload fires its handler. The data never leaves the page, but the sink is the same one a stored entry would reach.",
  fix: "Put user data into the page as text (textContent, a text node, a framework's default interpolation), never into an HTML string.",
  realism: "Optimistic previews, \"you typed …\" confirmations and client-side search-as-you-type that render a field's value back into the page with innerHTML.",
  routes: (variant) => ({
    "/": html(
      page(
        "Guestbook",
        `<h1>Guestbook</h1>
<form id="entry">
  <label for="message">Your message</label>
  <input id="message" name="message" type="text">
  <button type="submit">Sign</button>
</form>
<p id="preview"></p>
<script>
    const input = document.getElementById("message");
    const preview = document.getElementById("preview");
    document.getElementById("entry").addEventListener("submit", (event) => {
      event.preventDefault();${echo[variant]}
    });
</script>`,
      ),
    ),
  }),
  inject: {
    channel: "form",
    bad: '<details open ontoggle="window.__cb_xss_fired=1"></details>',
    benign: "hello",
  },
  // One action is enough: payloadDriver fills the single field and submits it.
  crawl: { maxActionsPerPage: 1 },
  expect: {
    signal: { kind: "invariant", name: "data.xss-marker" },
    alsoSignals: [{ kind: "invariant", name: "data.injected-markup" }],
    // The fix echoes the entry as the text that was typed.
    fixedText: /You said:/,
  },
});
