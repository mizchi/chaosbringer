import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages greet the user by name. The buggy page concatenates whatever
// `user.name` holds; the fixed one checks there is a name before using it.
const greet: Record<Variant, string> = {
  buggy: `
      greeting.textContent = "Hello, " + data.user.name + "!";`,
  fixed: `
      const name = data.user?.name;
      greeting.textContent = typeof name === "string" && name !== "" ? "Hello, " + name + "!" : "Hello! Add your name in your profile.";`,
};

export default definePattern({
  id: "rendered-undefined",
  title: "A missing field concatenated into text",
  category: "bug-data",
  description:
    'The profile page greets the user with "Hello, " + user.name. The profile endpoint leaves out fields that have no value, so a user who never set a name arrives as { user: {} }, and string concatenation turns the missing field into the word "undefined" on screen. Nothing throws, so no error is reported; only the rendered text shows it.',
  fix: "Check a field is there before rendering it and show a fallback when it isn't; don't let concatenation or a template literal turn undefined into text.",
  realism: "Serializers that drop null or unset fields (omitempty, JSON.stringify skipping undefined), optional profile fields, partial GraphQL selections.",
  routes: (variant) => ({
    "/": html(
      page(
        "Profile",
        `<h1>Profile</h1>
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
    bad: '{"user":{}}',
    benign: '{"user":{"name":"Ada"}}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.rendered-garbage" },
    fixedText: /Add your name/,
  },
});
