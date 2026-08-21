/**
 * PATTERNS AUDIT app under test.
 *
 * Nothing here replaces the shipped example. `createApp(fixed)` from
 * `../server.ts` is mounted underneath unchanged, so every `/api/...` route,
 * every dedup rule and every count endpoint the shipped bridges probe behaves
 * exactly as it does in `patterns.test.ts`. This server only adds
 *
 *   1. audit *pages* under `/audit/...`, each a variant of one shipped page
 *      carrying one bug the pattern's own plans are asked to catch, and
 *   2. a raw request ledger.
 *
 * The ledger is the independent measurement. It records method + full URL for
 * every request that reaches the server, before delegation — so it sees calls
 * no `rules` regex matched, calls the fault layers never counted, and calls
 * that arrive after the oracle has finished. A count endpoint the page itself
 * parameterises cannot lie to it, because the page never speaks to it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp as createShippedApp } from "../server.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

export interface LedgerEntry {
  method: string;
  path: string;
  query: string;
  session: string;
  key: string;
  body: string;
  atMs: number;
}

let ledger: LedgerEntry[] = [];
let t0 = Date.now();

/** Drop everything recorded so far and restart the clock. */
export function resetLedger(): void {
  ledger = [];
  t0 = Date.now();
}

/** Every request the server saw, in arrival order. */
export function readLedger(filter?: (e: LedgerEntry) => boolean): LedgerEntry[] {
  return filter ? ledger.filter(filter) : [...ledger];
}

/** Requests on one path, whatever query string they carried. */
export function callsOn(path: string, method = "GET"): LedgerEntry[] {
  return ledger.filter((e) => e.path === path && e.method === method);
}

function auditPage(title: string, body: string, script: string, fixed: boolean): string {
  const session = `au-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main id="app" data-state="idle">${body}</main>
<script>window.__AUDIT_FIXED__ = ${fixed ? "true" : "false"}; window.__SESSION__ = ${JSON.stringify(session)};</script>
<script src="/audit-js/${script}"></script></body></html>`;
}

export function createApp(fixed: boolean): Hono {
  const app = new Hono();
  const shipped = createShippedApp(fixed);

  // The ledger. Runs for every request, including ones no rule matches.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    let body = "";
    if (c.req.method === "POST") {
      body = await c.req.raw.clone().text().catch(() => "");
    }
    ledger.push({
      method: c.req.method,
      path: url.pathname,
      query: url.search,
      session: c.req.header("x-session") ?? url.searchParams.get("session") ?? "",
      key: c.req.header("idempotency-key") ?? "",
      body,
      atMs: Date.now() - t0,
    });
    await next();
  });

  app.get("/audit-js/:file", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, c.req.param("file")), "utf8"));
  });

  // --- F1: optimistic-rollback, a reconcile whose answer is discarded -----
  app.get("/audit/optimistic", (c) =>
    c.html(
      auditPage(
        "Notes (audit)",
        `<h1>Notes</h1><input id="text" value="Buy milk" aria-label="Note" />
         <button id="add">Add note</button>
         <p class="banner" id="banner">Nothing saved yet.</p><ul id="notes"></ul>`,
        "notes-blind-reconcile.js",
        fixed,
      ),
    ),
  );

  // --- F2: reconnect-budget, a resume loop that carries a cursor ----------
  app.get("/audit/stream", (c) =>
    c.html(
      auditPage(
        "Live feed (audit)",
        `<h1>Live feed</h1><button id="connect">Connect</button>
         <p class="banner" id="banner">Not connected.</p>`,
        "stream-resume.js",
        fixed,
      ),
    ),
  );

  // --- F3: pagination-order, data-idx from render position ----------------
  app.get("/audit/feed", (c) =>
    c.html(
      auditPage(
        "Feed (audit)",
        `<h1>Feed</h1><ol id="items"></ol><button id="more">Load more</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>`,
        "feed-position-idx.js",
        fixed,
      ),
    ),
  );

  // --- F4: timeout-ladder, a Promise.race "bound" -------------------------
  app.get("/audit/slow", (c) =>
    c.html(
      auditPage(
        "Report (audit)",
        `<h1>Report</h1><button id="load">Load report</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>`,
        "slow-race.js",
        fixed,
      ),
    ),
  );

  // --- F5: retry-idempotency, a retry that re-mints its session ----------
  app.get("/audit/retry", (c) =>
    c.html(
      auditPage(
        "Place order (audit)",
        `<h1>Place order</h1><button id="place">Place order</button>
         <p class="banner" id="banner">Nothing ordered yet.</p>`,
        "retry-resession.js",
        fixed,
      ),
    ),
  );

  // --- F8: token-refresh, a refresh failure no plan can reach -------------
  app.get("/audit/token", (c) =>
    c.html(
      auditPage(
        "Account (audit)",
        `<h1>Account</h1><button id="load">Load account</button>
         <p class="banner" id="banner">Nothing loaded yet.</p>`,
        "token-refresh-loop.js",
        fixed,
      ),
    ),
  );

  // --- R1/R2: retry variants that the pattern is expected to catch --------
  app.get("/audit/retry-uncapped", (c) =>
    c.html(
      auditPage(
        "Place order (audit)",
        `<h1>Place order</h1><button id="place">Place order</button>
         <p class="banner" id="banner">Nothing ordered yet.</p>`,
        "retry-uncapped.js",
        fixed,
      ),
    ),
  );

  app.get("/audit/retry-query", (c) =>
    c.html(
      auditPage(
        "Place order (audit)",
        `<h1>Place order</h1><button id="place">Place order</button>
         <p class="banner" id="banner">Nothing ordered yet.</p>`,
        "retry-query.js",
        fixed,
      ),
    ),
  );

  // Everything else — every /api/... route — is the shipped app, unchanged.
  app.all("*", (c) => shipped.fetch(c.req.raw));

  return app;
}

export function startServer(port = 0, fixed = false): Promise<StartedServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp(fixed).fetch, port }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
