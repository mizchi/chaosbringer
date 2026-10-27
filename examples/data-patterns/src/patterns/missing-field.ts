import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages show the account's email from its nested profile. The buggy page
// reads `profile.email` as if every account had a profile; the fixed one
// treats the profile as optional and says when there is none.
const show: Record<Variant, string> = {
  buggy: `
      email.textContent = data.profile.email;`,
  fixed: `
      email.textContent = data.profile?.email ?? "No email address on file.";`,
};

export default definePattern({
  id: "missing-field",
  title: "An optional nested object read as if it were always sent",
  category: "bug-data",
  description:
    "The settings page shows data.profile.email. An account that never finished onboarding has no profile, and the API leaves the key out instead of sending null, so data.profile is undefined and reading .email off it throws inside the async loader: the email stays on its loading text and the rejection escapes unhandled.",
  fix: "Treat the nested object as optional where it is read (optional chaining with a fallback, or a schema that marks it optional) and say what is missing.",
  realism: "Serializers that drop empty fields (omitempty, exclude_none, sparse fieldsets), profiles created lazily after sign-up, an API version that stopped sending a field.",
  routes: (variant) => ({
    "/": html(
      page(
        "Settings",
        `<h1>Settings</h1>
<p>Email: <span id="email">Loading…</span></p>
<script>
    const email = document.getElementById("email");
    async function load() {
      const res = await fetch("/api/me");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/me": json({ id: 1, profile: { email: "a@x.test" } }),
  }),
  inject: {
    channel: "response",
    path: "/api/me",
    bad: '{"id":1}',
    benign: '{"id":1,"profile":{"email":"a@x.test"}}',
  },
  expect: {
    signal: { kind: "error", message: /reading 'email'/ },
  },
});
