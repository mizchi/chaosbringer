import { definePattern, html, json, page, type Variant } from "../pattern.js";

// The whole page is rendered by script into an empty root, as a client-side
// app is. Both pages wrap the load in try/catch; the buggy catch does
// nothing, the fixed one renders an error state.
const onError: Record<Variant, string> = {
  buggy: `
      } catch {
        // Ignore: the page just stays as it is.
      }`,
  fixed: `
      } catch {
        app.textContent = "We couldn't load your account. Reload the page to try again.";
      }`,
};

export default definePattern({
  id: "swallowed-error-blank",
  title: "A swallowed error leaves a blank page",
  category: "bug-data",
  description:
    "The account page has no static content: script fetches the user and renders the whole page into an empty root, inside a try/catch whose catch does nothing. When the session endpoint answers { user: null }, reading .name throws, the catch swallows it, and the user is left looking at a blank page. No error escapes, so none is reported; only the empty page shows it.",
  fix: "A catch that handles an error must show it: render an error state (and report it to your error tracker) instead of returning with nothing on screen.",
  realism: "Client-side apps whose top-level loader or error boundary catches everything and renders nothing; a null relation from a session or profile endpoint.",
  routes: (variant) => ({
    "/": html(
      page(
        "Account",
        `<div id="app"></div>
<script>
    const app = document.getElementById("app");
    async function load() {
      try {
        const res = await fetch("/api/user");
        const data = await res.json();
        const heading = document.createElement("h1");
        heading.textContent = "Account";
        const greeting = document.createElement("p");
        greeting.textContent = "Signed in as " + data.user.name;
        app.replaceChildren(heading, greeting);${onError[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/user": json({ user: { name: "Ada" } }),
  }),
  inject: {
    channel: "response",
    path: "/api/user",
    bad: '{"user":null}',
    benign: '{"user":{"name":"Ada"}}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.not-blank" },
  },
});
