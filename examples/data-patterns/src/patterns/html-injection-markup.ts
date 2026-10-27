import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages show who is signed in. The buggy page builds the line as an
// HTML string around the display name; the fixed one builds the element and
// puts the name in as text.
const signedIn: Record<Variant, string> = {
  buggy: `
      who.innerHTML = "Signed in as <strong>" + data.name + "</strong>";`,
  fixed: `
      const strong = document.createElement("strong");
      strong.textContent = data.name;
      who.replaceChildren("Signed in as ", strong);`,
};

export default definePattern({
  id: "html-injection-markup",
  title: "A display name concatenated into innerHTML",
  category: "malicious-data",
  description:
    "The header shows \"Signed in as <strong>name</strong>\", built as an HTML string with the display name pasted in. A name that is itself markup renders as markup: a bold \"Admin\" badge, a link, a fake sign-in form. Nothing has to execute for that to mislead the reader, so blocking scripts doesn't stop it.",
  fix: "Put user data into the page as text (textContent, a text node, a framework's default interpolation), never into an HTML string.",
  realism: "Display names, team and project names, and notification text that the server returns as typed and the client renders with innerHTML or a template string.",
  routes: (variant) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
<p id="who">Loading…</p>
<script>
    const who = document.getElementById("who");
    async function load() {
      const res = await fetch("/api/user");
      const data = await res.json();${signedIn[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/user": json({ name: "Ada" }),
  }),
  inject: {
    channel: "response",
    path: "/api/user",
    bad: '{"name":"<b data-cb-injected>Admin</b>"}',
    benign: '{"name":"Ada"}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.injected-markup" },
  },
});
