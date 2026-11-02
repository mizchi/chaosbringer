import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages show the user's avatar. The buggy page builds the <img> as an
// HTML string with the avatar URL pasted into the src attribute, so a value
// carrying a quote closes the attribute and adds an onerror handler of its
// own. The fixed page builds the element through the DOM and only sets a src
// it has checked is an image URL, so the value can never become an attribute.
const avatarRe = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const show: Record<Variant, string> = {
  buggy: `
      box.innerHTML = '<img class="avatar" alt="Avatar" src="' + profile.avatar + '">';`,
  fixed: `
      const safe = URL.canParse(profile.avatar) &&
        (/^https?:$/.test(new URL(profile.avatar).protocol) || ${avatarRe.toString()}.test(profile.avatar));
      if (safe) {
        const img = document.createElement("img");
        img.className = "avatar";
        img.alt = "Avatar";
        img.src = profile.avatar;
        box.replaceChildren(img);
      } else {
        box.textContent = "No avatar";
      }`,
};

export default definePattern({
  id: "attribute-breakout-xss",
  title: "An avatar URL concatenated into a src attribute",
  category: "malicious-data",
  description:
    'The profile page shows an avatar with box.innerHTML = \'<img src="\' + profile.avatar + \'">\'. The avatar is a string the user supplied, so one containing a quote breaks out of the src attribute: data:image/png;base64,AA" onerror="… adds a handler the author never wrote, and a data: image that fails to decode fires it. Escaping the body of the string is not enough; the attribute boundary is the hole.',
  fix: "Build the element through the DOM (createElement + setAttribute / properties) and set a URL only after checking it is an image address, so a value can never become part of the markup.",
  realism: "Avatars, cover images, QR codes and share-card images whose URL or data: payload the server stores as given and the client drops into an <img> built from a string.",
  routes: (variant) => ({
    "/": html(
      page(
        "Profile",
        `<h1>Profile</h1>
<div id="avatar">Loading…</div>
<script>
    const box = document.getElementById("avatar");
    async function load() {
      const res = await fetch("/api/profile");
      const profile = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/profile": json({ avatar: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" }),
  }),
  inject: {
    channel: "response",
    path: "/api/profile",
    // The quote closes the src attribute; the rest becomes a real onerror
    // handler, which a data: image needs no request to fire.
    bad: '{"avatar":"data:image/png;base64,AA\\" onerror=\\"window.__cb_xss_fired=1"}',
    benign: '{"avatar":"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="}',
  },
  crawl: { maxActionsPerPage: 0 },
  expect: {
    signal: { kind: "invariant", name: "data.xss-marker" },
    // The handler ran (xss-marker) and the broken-out `onerror` attribute
    // names the marker in the DOM (injected-markup).
    alsoSignals: [{ kind: "invariant", name: "data.injected-markup" }],
    // The fix rejects the malformed value and shows a placeholder, with no
    // failing image load (which would be a console error) on the way.
    fixedText: /No avatar/,
  },
});
