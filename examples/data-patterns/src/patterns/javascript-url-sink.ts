import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages link the website a user put in their profile. The buggy page
// assigns whatever string it got to href; the fixed one parses it and links
// only a web address, showing anything else as text.
const link: Record<Variant, string> = {
  buggy: `
      const a = document.createElement("a");
      a.href = profile.website;
      a.textContent = profile.website;
      website.replaceChildren("Website: ", a);`,
  fixed: `
      const url = URL.canParse(profile.website) ? new URL(profile.website) : null;
      if (url && (url.protocol === "https:" || url.protocol === "http:")) {
        const a = document.createElement("a");
        a.href = url.href;
        a.textContent = profile.website;
        website.replaceChildren("Website: ", a);
      } else {
        website.textContent = "Website: " + profile.website;
      }`,
};

export default definePattern({
  id: "javascript-url-sink",
  title: "A user-supplied URL assigned to href unchecked",
  category: "malicious-data",
  description:
    "The profile page turns the website field into a link with a.href = profile.website. Building the element through the DOM keeps markup out, but not the scheme: a website of javascript:… becomes a link that runs the attacker's script in the viewer's session when clicked. textContent and setAttribute don't help; the value itself has to be checked.",
  fix: "Parse the URL and link it only when its protocol is http: or https: (an allowlist, not a javascript: denylist, which misses java\\tscript: and data:); otherwise show it as text.",
  realism:
    "Profile, homepage and \"link to your portfolio\" fields, CRM records and chat messages that store a URL as typed and render it as a link.",
  routes: (variant) => ({
    "/": html(
      page(
        "Profile",
        `<h1>Profile</h1>
<p id="website">Loading…</p>
<script>
    const website = document.getElementById("website");
    async function load() {
      const res = await fetch("/api/profile");
      const profile = await res.json();${link[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/profile": json({ website: "https://example.org/" }),
  }),
  inject: {
    channel: "response",
    path: "/api/profile",
    bad: '{"website":"javascript:window.__cb_xss_fired=1"}',
    benign: '{"website":"https://example.org/"}',
  },
  // The crawler never clicks a javascript: link, so the check is on the
  // sink: data.injected-markup flags the href once the page has rendered it.
  crawl: { maxActionsPerPage: 0 },
  expect: {
    signal: { kind: "invariant", name: "data.injected-markup" },
    // The fix shows the rejected URL as text, not as a link.
    fixedText: /Website:/,
  },
});
