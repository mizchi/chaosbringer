import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages ask the session endpoint who is signed in. The buggy page reads
// `user.name` straight off the answer; the fixed one treats `user` as what
// the API says it is, nullable, and shows the signed-out state.
const greet: Record<Variant, string> = {
  buggy: `
      greeting.textContent = "Hello, " + data.user.name;`,
  fixed: `
      greeting.textContent = data.user ? "Hello, " + data.user.name : "You are signed out.";`,
};

export default definePattern({
  id: "null-relation",
  title: "A nullable relation read as if it were always there",
  category: "bug-data",
  description:
    "The account page greets the signed-in user with data.user.name. The session endpoint answers { user: null } for a visitor whose session has expired or whose account was deleted, and reading .name off null throws inside the async loader: the greeting stays on its loading text and the rejection escapes unhandled.",
  fix: "Model the relation as nullable where it is read (a null check, optional chaining with a fallback, or a type that says User | null) and render the empty state.",
  realism: "Session and profile endpoints that return null for a signed-out or deleted user; ORM includes and LEFT JOINs that find no row.",
  routes: (variant) => ({
    "/": html(
      page(
        "Account",
        `<h1>Account</h1>
<p id="greeting">Loading…</p>
<script>
    const greeting = document.getElementById("greeting");
    async function load() {
      const res = await fetch("/api/user");
      const data = await res.json();${greet[variant]}
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
    signal: { kind: "error", message: /Cannot read properties of null \(reading 'name'\)/ },
  },
});
