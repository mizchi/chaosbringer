import { definePattern, html, json, page, raw, type Variant } from "../pattern.js";

// Both pages cut the name to fit the profile badge and ask the badge service
// to draw it. The buggy page cuts by UTF-16 code unit, which can split an
// emoji's surrogate pair, and encodeURIComponent refuses a lone surrogate;
// the fixed one cuts by grapheme, so an emoji stays whole.
const truncate: Record<Variant, string> = {
  buggy: `
    function truncate(s, max) {
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }`,
  fixed: `
    function truncate(s, max) {
      const graphemes = Array.from(new Intl.Segmenter().segment(s), (g) => g.segment);
      return graphemes.length > max ? graphemes.slice(0, max - 1).join("") + "…" : s;
    }`,
};

// The badge service draws the label it is sent; a fixed pill stands in for it,
// since only the request's URL matters here.
const BADGE = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24"><rect width="64" height="24" rx="12" fill="#ddd"/></svg>';

export default definePattern({
  id: "unicode-surrogate-split",
  title: "A string cut through an emoji, then URL-encoded",
  category: "bug-data",
  description:
    "The profile page cuts the user's name to six characters for the badge with name.slice() and puts it in the badge image's URL. slice counts UTF-16 code units, so for \"Ada 😀!\" the cut lands between the two halves of the emoji, and encodeURIComponent throws a URIError on the lone surrogate inside the async loader: the name stays on its loading text and the rejection escapes unhandled.",
  fix: "Cut user text by grapheme (Intl.Segmenter) or at least by code point (Array.from), never with slice/substring on UTF-16 units, before encoding or storing it.",
  realism: "Display names, titles and previews cut to a length budget for badges, share links, push notifications or column limits; any text with emoji or other characters outside the BMP.",
  routes: (variant) => ({
    "/": html(
      page(
        "Profile",
        `<h1>Profile</h1>
<p id="who">Loading…</p>
<img id="badge" alt="" width="64" height="24">
<script>
    const who = document.getElementById("who");
    const badge = document.getElementById("badge");${truncate[variant]}
    async function load() {
      const res = await fetch("/api/user");
      const data = await res.json();
      badge.src = "/badge.svg?label=" + encodeURIComponent(truncate(data.name, 6));
      who.textContent = data.name;
    }
    load();
</script>`,
      ),
    ),
    "/api/user": json({ name: "Ada Lovelace" }),
    "/badge.svg": raw(BADGE, "image/svg+xml"),
  }),
  inject: {
    channel: "response",
    path: "/api/user",
    bad: '{"name":"Ada 😀!"}',
    benign: '{"name":"Ada Lovelace"}',
  },
  expect: {
    signal: { kind: "error", message: /URI malformed/ },
  },
});
