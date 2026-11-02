import { definePattern, html, page, type Variant } from "../pattern.js";

// The marker page on the catalog's own third-party server (`localhost`, a
// different site from the app's `127.0.0.1`): where the redirect must not go.
const MARKER_PATH = "/cb-offsite-marker";

// Both pages send the user on to ?next= once they are signed in. The buggy
// page navigates to whatever it was given; the fixed one resolves it against
// its own origin and follows it only when it stays there.
const go: Record<Variant, string> = {
  buggy: `
    location.replace(next);`,
  fixed: `
    const target = URL.canParse(next, location.origin) ? new URL(next, location.origin) : null;
    location.replace(target?.origin === location.origin ? target.pathname + target.search + target.hash : "/home");`,
};

export default definePattern({
  id: "open-redirect-param",
  title: "A ?next= redirect that follows any URL",
  category: "malicious-data",
  description:
    "After sign-in the /go page sends the user back to where they came from with location.replace(next), next taken from the query string. A link to /go?next=https://evil.example/ starts on the real domain, which the user trusts, and ends on the attacker's look-alike sign-in page. Protocol-relative (//evil.example) and backslash (/\\evil.example) forms get past a naive startsWith(\"/\") check too.",
  fix: "Resolve next against the site's own origin and follow it only when the origin is unchanged (or the target is on an allowlist); otherwise go to a default page.",
  realism: "Login, logout and \"return to\" parameters (next, returnUrl, redirect_uri, continue) passed through links, emails and OAuth flows.",
  routes: (variant) => ({
    "/go": html(
      page(
        "Signing in",
        `<h1>Signing you in…</h1>
<p>Taking you back to where you were.</p>
<script>
    const next = new URLSearchParams(location.search).get("next") || "/home";${go[variant]}
</script>`,
      ),
    ),
    "/home": html(page("Home", "<h1>Home</h1>\n<p>Welcome back.</p>")),
  }),
  thirdPartyRoutes: () => ({
    [MARKER_PATH]: html(page("Off-site", "<h1>Off-site</h1>\n<p>An open redirect sent the browser here.</p>")),
  }),
  inject: {
    channel: "query",
    bad: (ctx) => `?next=${encodeURIComponent(ctx.thirdPartyOrigin + MARKER_PATH)}`,
    benign: "?next=/home",
  },
  crawl: { entry: "/go" },
  // Only pages[].blockedNavigations records this: the crawler blocks the
  // off-site navigation, which fails no exit code and raises no scan finding.
  expect: {
    signal: { kind: "blocked-navigation", includes: MARKER_PATH },
  },
});
