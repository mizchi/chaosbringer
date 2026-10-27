import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages render a greeting from a server-supplied template with {name}
// placeholders. The buggy renderer "optimized" the substitution by rewriting
// {name} to ${name} and evaluating the whole string as a JavaScript template
// literal with new Function, so any ${…} the template already contains runs
// as code. The fixed renderer substitutes the named fields and nothing else.
const render: Record<Variant, string> = {
  buggy: `
    function render(tpl, vars) {
      const names = Object.keys(vars);
      const body = "return \`" + tpl.replace(/\\{(\\w+)\\}/g, "\${$1}") + "\`";
      return new Function(...names, body)(...names.map((n) => vars[n]));
    }`,
  fixed: `
    function render(tpl, vars) {
      return tpl.replace(/\\{(\\w+)\\}/g, (_, key) => String(vars[key] ?? ""));
    }`,
};

export default definePattern({
  id: "template-injection",
  title: "A greeting template evaluated with new Function",
  category: "malicious-data",
  description:
    "The page renders a greeting from a template the server sends, like \"Hi {name}\". The buggy renderer turns {name} into ${name} and evaluates the result as a template literal with new Function, so a template that already contains ${…} — one an admin pasted, or a tenant set — runs as code in the visitor's session. The fix substitutes the named fields with a plain replace, which never evaluates anything.",
  fix: "Substitute placeholders with a plain string replacement (or a sandboxed template library); never build a template literal and hand it to new Function or eval.",
  realism: "Notification, email-preview and CMS templates with {placeholder} fields, rendered client-side by a home-grown engine that reached for new Function or eval.",
  routes: (variant) => ({
    "/": html(
      page(
        "Greeting",
        `<h1>Greeting</h1>
<p id="greeting">Loading…</p>
<script>${render[variant]}
    async function load() {
      const res = await fetch("/api/greeting");
      const data = await res.json();
      document.getElementById("greeting").textContent = render(data.tpl, { name: data.name });
    }
    load();
</script>`,
      ),
    ),
    "/api/greeting": json({ tpl: "Hi {name}", name: "Ada" }),
  }),
  inject: {
    channel: "response",
    path: "/api/greeting",
    bad: '{"tpl":"Hi ${window.__cb_xss_fired=1}","name":"Ada"}',
    benign: '{"tpl":"Hi {name}","name":"Ada"}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.xss-marker" },
    // The fix leaves a ${…} it doesn't recognize as a placeholder on screen
    // as text, rather than evaluating it.
    fixedText: /Hi \$\{/,
  },
});
