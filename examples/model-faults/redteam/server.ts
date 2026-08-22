/**
 * RED TEAM app under test.
 *
 * Five routes, each carrying one async bug that a production app could
 * plausibly ship, chosen so that the model runner's four oracle signals
 * (ui / unhandledRejection / injection / state) all agree with the model
 * while the app is wrong.
 *
 * Same convention as the sibling example: `window.__RT_FIXED__` selects the
 * corrected variant, `window.__SESSION__` scopes server-side counters to one
 * page load so concurrent plan runs cannot see each other's writes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

/** Server-side effects, per session. This is the ground truth the page cannot lie about. */
export interface Effects {
  charges: Array<{ amount: number; appState: string }>;
  telemetry: number;
  orders: Set<string>;
  orderPosts: number;
  searchCalls: string[];
}

const effects = new Map<string, Effects>();

function effectsFor(session: string): Effects {
  let e = effects.get(session);
  if (!e) {
    e = { charges: [], telemetry: 0, orders: new Set(), orderPosts: 0, searchCalls: [] };
    effects.set(session, e);
  }
  return e;
}

export function readEffects(session: string): Effects {
  return effectsFor(session);
}

/** Every session recorded so far, newest last. Lets a harness find the run's session. */
export function allSessions(): string[] {
  return [...effects.keys()];
}

/** How long the backend takes to commit a write it has already acknowledged. */
const COMMIT_LATENCY_MS = 450;

function page(title: string, body: string, script: string, fixed: boolean): string {
  const session = `rt-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main id="app" data-state="idle">${body}</main>
<script>window.__RT_FIXED__ = ${fixed ? "true" : "false"}; window.__SESSION__ = ${JSON.stringify(session)};</script>
<script src="/${script}"></script></body></html>`;
}

function js(file: string): string {
  return readFileSync(join(publicDir, file), "utf8");
}

export function createApp(fixed: boolean): Hono {
  const app = new Hono();

  const serveJs = (file: string) => (c: { header: (k: string, v: string) => void; body: (b: string) => Response }) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(js(file));
  };

  // ---------------------------------------------------------------- HOLE A
  // A failed refresh leaves stale money on screen and the primary action
  // enabled. `data-state` says "error", so the ui probe is satisfied.
  app.get("/quote", (c) =>
    c.html(
      page(
        "Quote",
        `<h1>Quote</h1><button id="refresh">Refresh price</button>
         <button id="pay" disabled>Pay</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>
         <dl id="summary"></dl>`,
        "quote.js",
        fixed,
      ),
    ),
  );
  app.get("/quote.js", serveJs("quote.js") as never);
  app.get("/api/quote", (c) => c.json({ price: 80, rev: 1 }));
  app.post("/api/charge", async (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    const body = (await c.req.json()) as { amount: number; appState: string };
    effectsFor(session).charges.push({ amount: body.amount, appState: body.appState });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- HOLE B
  // Heartbeat interval with a units bug (60 instead of 60_000). The plan
  // faults the first beacon; every later one sails past an oracle that only
  // ever checks for *too few* firings.
  app.get("/poll", (c) =>
    c.html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1><button id="start">Start</button>
         <p class="banner" id="banner">Nothing loaded yet.</p><ul id="feed"></ul>`,
        "poll.js",
        fixed,
      ),
    ),
  );
  app.get("/poll.js", serveJs("poll.js") as never);
  app.get("/api/feed", (c) => c.json({ items: ["build 41 green", "build 42 green"] }));
  app.post("/api/telemetry", (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    effectsFor(session).telemetry += 1;
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- HOLE C
  // The "load" button renders a cached success and never calls the API.
  // Replayed against the sibling example's own committed happy-path plan.
  app.get("/fake", (c) =>
    c.html(
      page(
        "Checkout",
        `<h1>Checkout</h1><button id="load">Load order</button>
         <p class="banner" id="banner">Nothing loaded yet.</p><dl id="summary"></dl>`,
        "fake.js",
        fixed,
      ),
    ),
  );
  app.get("/fake.js", serveJs("fake.js") as never);

  // ---------------------------------------------------------------- HOLE D
  // Retry without one idempotency key per intent — the exact bug the
  // retry-idempotency pattern exists to catch — against a backend that
  // acknowledges a write immediately and commits it COMMIT_LATENCY_MS later.
  app.get("/order", (c) =>
    c.html(
      page(
        "Order",
        `<h1>Order</h1><button id="place">Place order</button>
         <p class="banner" id="banner">Nothing placed yet.</p>`,
        "order.js",
        fixed,
      ),
    ),
  );
  app.get("/order.js", serveJs("order.js") as never);
  app.post("/api/rt/order", async (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    const key = c.req.header("idempotency-key") ?? Math.random().toString(36);
    const e = effectsFor(session);
    e.orderPosts += 1;
    // Acknowledge now, commit later: a queue-backed backend, which is what
    // most "202 Accepted" APIs are.
    setTimeout(() => {
      e.orders.add(key);
    }, COMMIT_LATENCY_MS);
    return c.json({ id: `ord-${e.orderPosts}`, accepted: true });
  });
  app.get("/api/rt/orders/count", (c) => {
    const session = c.req.query("session") ?? "anonymous";
    const e = effectsFor(session);
    return c.json({ orders: e.orders.size, posts: e.orderPosts });
  });

  // ---------------------------------------------------------------- HOLE F
  // The error path schedules a retry with no rejection handler, 900ms later.
  app.get("/late", (c) =>
    c.html(
      page(
        "Late",
        `<h1>Late</h1><button id="load">Load</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>`,
        "late.js",
        fixed,
      ),
    ),
  );
  app.get("/late.js", serveJs("late.js") as never);
  app.get("/api/quote-v2", (c) => c.json({ error: "gone" }, 500));

  // ------------------------------------------------------ REFUTATION probe
  // The same load, over XMLHttpRequest — outside every fetch-scoped fault.
  app.get("/xhr", (c) =>
    c.html(
      page(
        "XHR",
        `<h1>XHR</h1><button id="load">Load</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>`,
        "xhr.js",
        fixed,
      ),
    ),
  );
  app.get("/xhr.js", serveJs("xhr.js") as never);

  // ---------------------------------------------------------------- HOLE E
  // Search-as-you-type with no request-generation guard: the older, slower
  // response wins and the page shows results for a query the user has
  // already replaced.
  app.get("/race", (c) =>
    c.html(
      page(
        "Search",
        `<h1>Search</h1><input id="q" aria-label="Search" />
         <p class="banner" id="banner">Type to search.</p>
         <p id="shown" data-q="">No results.</p>`,
        "race.js",
        fixed,
      ),
    ),
  );
  app.get("/race.js", serveJs("race.js") as never);
  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const session = c.req.header("x-session") ?? "anonymous";
    effectsFor(session).searchCalls.push(q);
    return c.json({ q, results: [`${q}-one`, `${q}-two`] });
  });

  return app;
}

export function startServer(port = 0, fixed = process.env.FIXED === "1"): Promise<StartedServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp(fixed).fetch, port }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startServer(Number.parseInt(process.env.PORT ?? "5199", 10));
  console.log(`redteam app (${process.env.FIXED === "1" ? "fixed" : "buggy"}) on ${url}`);
}
