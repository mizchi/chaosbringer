import type { IncomingMessage, ServerResponse } from "node:http";
import { definePattern, handler, html, page, type Routes, type Variant } from "../pattern.js";

const WIDGETS = 6;
const PREFLIGHT_DELAY_MS = 250;
const API_DELAY_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A dashboard on the app's origin loads its widgets from an API on another
// origin (here `localhost`, the app is on 127.0.0.1): six GETs, in parallel.
// The slow page's API client adds the same default headers to every call,
// `Content-Type: application/json` and an `X-Client-Version` header. Neither
// is CORS-safelisted on a GET (application/json is not a "simple" content
// type, and a custom header never is), so the browser sends an OPTIONS
// preflight before each GET and waits for it: one more round trip per call,
// and the API answers no `Access-Control-Max-Age`, so nothing is reused.
// The fixed client sends only safelisted headers (no Content-Type on a
// request without a body, the version in the query string): simple requests,
// which go straight out.
const client: Record<Variant, string> = {
  slow: `const api = (path) => fetch(API + path, {
      headers: { "Content-Type": "application/json", "X-Client-Version": "4.2" },
    }).then((r) => r.json());`,
  fixed: `const api = (path) => fetch(API + path + "?client=4.2").then((r) => r.json());`,
};

async function widgetApi(req: IncomingMessage, res: ServerResponse) {
  const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  if (req.method === "OPTIONS") {
    // The preflight: the same server, so the same distance away; no max-age.
    await sleep(PREFLIGHT_DELAY_MS);
    res.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "content-type, x-client-version",
    });
    res.end();
    return;
  }
  await sleep(API_DELAY_MS);
  const id = new URL(req.url ?? "/", "http://x").pathname.split("/").pop() ?? "";
  res.writeHead(200, { ...cors, "content-type": "application/json" });
  res.end(JSON.stringify({ id, value: id.length * 17 }));
}

export default definePattern({
  id: "cors-preflight-per-request",
  title: "Cross-origin API calls that each need a CORS preflight",
  category: "network",
  description: `A dashboard fetches ${WIDGETS} widgets from its API on another origin. The API client sets Content-Type: application/json and a custom X-Client-Version header on every call, GETs included, which makes each one a non-simple CORS request: the browser first sends an OPTIONS preflight and waits for its answer, and the API sends no Access-Control-Max-Age. Every call pays an extra round trip (${PREFLIGHT_DELAY_MS} ms here) before it starts, and the dashboard fills that much later.`,
  fix: "Keep cross-origin GETs simple: no Content-Type on a request without a body, no custom headers (put versions and flags in the query string); where headers are needed, answer preflights with Access-Control-Max-Age so repeat calls skip them, or serve the API from the page's own origin (a reverse proxy under /api).",
  routes: (variant, { thirdPartyOrigin }) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
<ul id="widgets"></ul>
<script>
    const API = ${JSON.stringify(`${thirdPartyOrigin}/api/widgets/`)};
    ${client[variant]}
    const names = ${JSON.stringify(Array.from({ length: WIDGETS }, (_, i) => `w${i + 1}`))};
    Promise.all(names.map(api)).then((all) => {
      document.getElementById("widgets").innerHTML = all.map((w) => "<li>" + w.id + ": " + w.value + "</li>").join("");
    });
</script>`,
      ),
    ),
  }),
  thirdPartyRoutes: (): Routes =>
    Object.fromEntries(Array.from({ length: WIDGETS }, (_, i) => [`/api/widgets/w${i + 1}`, handler(widgetApi)])),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // Until the last widget's response is in: the request, and on the slow
    // page the preflight before it (both variants' GETs run in parallel).
    metric: "network.settledMs",
    direction: "lower",
    // slow: preflight (250 ms) then GET (30 ms), ~330 ms; fixed: the GETs alone, ~70 ms.
    minImprovement: { ratio: 2, absolute: 150 },
    alsoExpect: [
      {
        // CDP reports each preflight as a request of its own (initiator type
        // "preflight"), on the API's origin: 6 preflights + 6 GETs against 6 GETs.
        metric: "page.network.thirdParty.requestCount",
        direction: "lower",
        minImprovement: { absolute: 5 },
      },
    ],
  },
});
