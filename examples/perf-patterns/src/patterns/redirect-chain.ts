import type { ServerResponse } from "node:http";
import { definePattern, handler, page, type Variant } from "../pattern.js";

const HOP_MS = 200;

// Query parameters the slow app insists on seeing in the URL, one redirect
// each: locale, then time zone, then the A/B bucket. Each hop is a full round
// trip to a server that looks up a session before answering (HOP_MS).
const STEPS = [
  ["locale", "en"],
  ["tz", "utc"],
  ["ab", "b"],
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const APP = page(
  "Dashboard",
  `<h1>Dashboard</h1>
<p>Welcome back. You have 3 new messages.</p>`,
);

function sendApp(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(APP);
}

const app: Record<Variant, Parameters<typeof handler>[0]> = {
  // Redirect until every parameter is in the URL: three 302s before any HTML.
  slow: async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const missing = STEPS.find(([k]) => !url.searchParams.has(k));
    if (missing) {
      await sleep(HOP_MS);
      url.searchParams.set(missing[0], missing[1]);
      res.writeHead(302, { location: url.pathname + url.search, "cache-control": "no-store" });
      res.end();
      return;
    }
    sendApp(res);
  },
  // Resolve the same defaults on the server (from the session, Accept-Language,
  // a cookie) and answer the first request.
  fixed: (_req, res) => sendApp(res),
};

export default definePattern({
  id: "redirect-chain",
  title: "Redirect chain before the first byte",
  category: "network",
  description: `Opening /app answers with a 302 to add ?locale=, which answers with a 302 to add &tz=, which answers with a 302 to add &ab=: three round trips of ${HOP_MS} ms each before the server sends a single byte of HTML. Every visitor who follows a link or a bookmark to /app pays for them.`,
  fix: "Resolve defaults on the server (session, cookie, Accept-Language) and serve the page on the first request; link to the final URL; collapse unavoidable redirects into one hop.",
  routes: (variant) => ({
    "/app": handler(app[variant]),
  }),
  crawl: {
    entry: "/app",
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/app :: load",
    // web-vitals TTFB counts from the start of the navigation, redirects included.
    metric: "page.vitals.TTFB.value",
    direction: "lower",
    // slow: three 200 ms hops before the first byte, ~620 ms; fixed: one request, a few ms.
    minImprovement: { ratio: 5, absolute: 300 },
  },
});
