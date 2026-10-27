import { definePattern, html, json, page } from "../pattern.js";

// A moderation queue shows hostile input verbatim, which is its job: the
// payloads are text everywhere they appear. The server escapes the reported
// comments into the HTML (text, title attributes, a read-only textarea), and
// the page puts the pending profile edits into the DOM with textContent,
// .value, .title and dataset. The markers are on the page as text and inside
// attribute values, never as a running script, an element with the canary
// attribute, or a javascript: URL.
const DETAILS = '<details open ontoggle="window.__cb_xss_fired=1"></details>';
const MARKUP = "<b data-cb-injected>Admin</b> approved this";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const reported = [
  { author: "mallory", body: DETAILS },
  { author: "trudy", body: MARKUP },
]
  .map(
    (r) => `  <li>
    <blockquote title="${escapeHtml(r.body)}">${escapeHtml(r.body)}</blockquote>
    <p>Reported comment by ${escapeHtml(r.author)}</p>
    <textarea readonly rows="1" cols="60" aria-label="Raw text of the comment by ${escapeHtml(r.author)}">${escapeHtml(r.body)}</textarea>
  </li>`,
  )
  .join("\n");

const body = `<h1>Moderation queue</h1>
<h2>Reported comments</h2>
<ul>
${reported}
</ul>
<h2>Pending profile edits</h2>
<form id="edits"><p>Loading…</p></form>
<p><a href="/?q=${encodeURIComponent("window.__cb_xss_fired")}" title="${escapeHtml(DETAILS)}">Find every report that mentions window.__cb_xss_fired</a></p>
<script>
    const form = document.getElementById("edits");
    async function load() {
      const res = await fetch("/api/edits");
      const edits = await res.json();
      form.replaceChildren(
        ...edits.map((edit, i) => {
          const row = document.createElement("p");
          const label = document.createElement("label");
          label.htmlFor = "edit-" + i;
          label.textContent = edit.user + " wants to set " + edit.field + " to " + edit.value;
          const field = document.createElement(edit.field === "bio" ? "textarea" : "input");
          field.id = "edit-" + i;
          field.value = edit.value;
          field.title = edit.value;
          field.dataset.original = edit.value;
          const similar = document.createElement("a");
          similar.href = "/?q=" + encodeURIComponent(edit.value);
          similar.textContent = "similar edits";
          row.append(label, " ", field, " ", similar);
          return row;
        }),
      );
    }
    load();
</script>`;

export default definePattern({
  id: "oracle-escaped-payload",
  title: "A moderation queue that shows XSS payloads as text",
  category: "oracle",
  description:
    "Moderators see hostile input as it was sent: reported comments carrying a <details ontoggle> payload and markup with the data-cb-injected attribute, escaped by the server into text, a title attribute and a read-only textarea; pending profile edits (a javascript: website, an <img onerror> bio, an <input onfocus> name) put into form fields, titles, data attributes and a search link's query by the page. A check that searched the page's text or attribute values for the markers would flag the one page whose job is to show them.",
  fix: "Nothing to fix: the presets look for a marker that ran, an element carrying the canary attribute, or a javascript: URL in a URL attribute, not for the marker's text.",
  realism: "Moderation queues, admin audit logs, security advisories and bug trackers that quote payloads; forms that put rejected input back for correction.",
  routes: () => ({
    "/": html(page("Moderation queue", body)),
    "/api/edits": json([
      { user: "mallory", field: "website", value: "javascript:window.__cb_xss_fired=1" },
      { user: "trudy", field: "bio", value: '<img src="data:,x" onerror="window.__cb_xss_fired=1">' },
      { user: "eve", field: "name", value: '<input autofocus onfocus="window.__cb_xss_fired=1">' },
    ]),
  }),
  inject: { channel: "none" },
  expect: { signal: "none" },
});
