/**
 * Dogfood playground server.
 *
 * Two variants of the same app, served on different ports, parameterised
 * by the `VARIANT` env var. `v1` is the "correct" reference; `v2` has
 * intentional divergences seeded for chaosbringer's diff / parity /
 * cluster-artifacts tools to find. The bugs are NOT subtle in the code
 * — they are subtle in their *symptoms* — so an agent reading reports
 * (not source) has to do real work.
 *
 * server-faults is mounted on both variants, driven by `CHAOS_*` env
 * vars. With everything unset it's a no-op; with rates / windows set
 * each new fault kind from this PR can be exercised end-to-end.
 *
 * To keep this file the single source of truth for what an agent loop
 * sees, the seeded bugs are listed in BUG_LEDGER below — useful as a
 * grading rubric after a loop finishes ("did the agent find bug X?").
 */

import { serve } from "@hono/node-server";
import type { ServerFaultConfig } from "@mizchi/server-faults";
import { honoMiddleware } from "@mizchi/server-faults/hono";
import { Hono } from "hono";

const VARIANT = (process.env.VARIANT === "v2" ? "v2" : "v1") as "v1" | "v2";
const PORT = Number.parseInt(process.env.PORT ?? "5001", 10);

// ─── Seeded bugs ──────────────────────────────────────────────────────────
// Each entry: where the divergence lives + what tool should catch it.
// Agents shouldn't read this file before running the loop. After a loop
// finishes, the seeded list can be cross-checked against what the agent
// reported.
export const BUG_LEDGER = [
  {
    id: "BUG-1",
    where: "GET /users/11",
    symptom: "v1 → 404, v2 → 500 (off-by-one in user-id bounds check)",
    catcher: "chaosbringer parity",
  },
  {
    id: "BUG-2",
    where: "GET /api/users/2",
    symptom: "v2 response is missing the `email` field that v1 includes",
    catcher: "chaosbringer parity --follow-redirects + manual body inspection (or invariant)",
  },
  {
    id: "BUG-3",
    where: "GET /admin",
    symptom: "v2 emits a console.error from an inline <script> referencing a missing var",
    catcher: "chaosbringer (cluster shows up only on v2 report → diff surfaces it)",
  },
  {
    id: "BUG-4",
    where: "GET /broken-link page",
    symptom: "v2 home page has an extra <a href='/does-not-exist'> that 404s on click",
    catcher: "chaosbringer (crawler hits the link, both report 404 → ignore-preset must NOT swallow it)",
  },
  {
    id: "BUG-5",
    where: "GET /api/users (and /api/users/:id)",
    symptom: "v2 returns `cache-control: no-store` where v1 returns `max-age=60` (policy drift)",
    catcher: "chaosbringer parity --check-headers cache-control",
  },
  {
    id: "BUG-6",
    where: "GET /dashboard",
    symptom:
      "v1 and v2 return byte-identical HTML; v2's bundle.js (served from /static/bundle.js) throws an uncaught ReferenceError on load. Invisible to status/body/header parity.",
    catcher: "chaosbringer parity --check-exceptions",
  },
  {
    id: "BUG-7",
    where: "POST /api/todos then GET /api/todos",
    symptom:
      "v2's POST returns 201 with an identical-shaped JSON response, but silently no-ops the write. A subsequent GET shows an empty list on v2 / one item on v1. Single-shot probes (parity --check-body on either path alone) can't see it.",
    catcher: "chaosbringer journey",
  },
  {
    id: "BUG-8",
    where: "POST /api/todos → GET /api/todos/<id>",
    symptom:
      "Both variants return matching 201 + id on POST. v1's GET by id returns the original title; v2's GET by id returns the title uppercased. Needs capture+template — single-shot parity can't hit the right id without knowing it in advance.",
    catcher: "chaosbringer journey (with capture: body.id → {{todoId}})",
  },
  {
    id: "BUG-9",
    where: "GET /api/users",
    symptom:
      "v2 sleeps 120ms before responding (a regression that doesn't move status / body / headers — only latency). Invisible to every existing parity check.",
    catcher: "chaosbringer parity --perf-delta-ms",
  },
  {
    id: "BUG-10",
    where: "Multi-actor journey: Alice creates a doc, Bob lists docs",
    symptom:
      "v1 isolates docs per user (Bob's list is empty). v2 ignores the session cookie and returns Alice's secret to Bob — a tenant-isolation breach invisible to any single-actor journey.",
    catcher: "chaosbringer journey with actor=alice / actor=bob",
  },
] as const;

// ─── server-faults config from env ────────────────────────────────────────
// Every fault kind shipped on this PR is reachable from a single set of
// env vars. Leaving them unset = no-op. The same config is applied to
// both variants so chaos is symmetric and parity output still represents
// real route differences, not fault-noise differences.
function loadChaosConfig(): ServerFaultConfig {
  const cfg: ServerFaultConfig = {
    metadataHeader: true,
    // Health checks should NEVER receive chaos — they'd flap the
    // playground's own readiness signal. exemptPath wins over all raffles.
    exemptPathPattern: /^\/health/,
    bypassHeader: "x-chaos-bypass",
  };
  const num = (k: string) => {
    const v = process.env[k];
    return v === undefined ? undefined : Number.parseFloat(v);
  };
  const status5xxRate = num("CHAOS_5XX_RATE");
  if (status5xxRate) cfg.status5xxRate = status5xxRate;
  const latencyRate = num("CHAOS_LATENCY_RATE");
  if (latencyRate) {
    cfg.latencyRate = latencyRate;
    cfg.latencyMs = num("CHAOS_LATENCY_MS") ?? 200;
  }
  const abortRate = num("CHAOS_ABORT_RATE");
  if (abortRate) {
    cfg.abortRate = abortRate;
    if (process.env.CHAOS_ABORT_STYLE === "reset") cfg.abortStyle = "reset";
  }
  const partialRate = num("CHAOS_PARTIAL_RATE");
  if (partialRate) {
    cfg.partialResponseRate = partialRate;
    cfg.partialResponseAfterBytes = num("CHAOS_PARTIAL_AFTER") ?? 32;
  }
  const slowRate = num("CHAOS_SLOW_RATE");
  if (slowRate) {
    cfg.slowStreaming = {
      rate: slowRate,
      chunkDelayMs: num("CHAOS_SLOW_DELAY") ?? 100,
      ...(process.env.CHAOS_SLOW_CHUNK
        ? { chunkSize: Number.parseInt(process.env.CHAOS_SLOW_CHUNK, 10) }
        : {}),
    };
  }
  const flapWindow = num("CHAOS_FLAP_WINDOW");
  const flapBad = num("CHAOS_FLAP_BAD");
  if (flapWindow && flapBad) {
    cfg.statusFlapping = { windowMs: flapWindow, badMs: flapBad };
  }
  return cfg;
}

// ─── App data ─────────────────────────────────────────────────────────────
interface User {
  id: number;
  name: string;
  email: string;
}
const USERS: User[] = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.test`,
}));

// ─── Routes ───────────────────────────────────────────────────────────────
const app = new Hono();
app.use("*", honoMiddleware(loadChaosConfig()));

app.get("/health", (c) => c.text("ok"));

app.get("/", (c) => {
  // BUG-4: v2 has an extra broken-link <a> that 404s on the next hop.
  const extra =
    VARIANT === "v2"
      ? `<li><a href="/does-not-exist">does-not-exist (broken)</a></li>`
      : "";
  return c.html(`<!doctype html>
<html><body>
<h1>Playground (${VARIANT}) — port ${PORT}</h1>
<ul>
  <li><a href="/users">Users</a></li>
  <li><a href="/users/1">User 1</a></li>
  <li><a href="/users/11">User 11 (edge)</a></li>
  <li><a href="/api/users">API: users</a></li>
  <li><a href="/api/users/2">API: user 2</a></li>
  <li><a href="/admin">Admin</a></li>
  ${extra}
</ul>
</body></html>`);
});

app.get("/users", (c) => {
  const items = USERS.map(
    (u) => `<li><a href="/users/${u.id}">${u.name}</a></li>`,
  ).join("");
  return c.html(`<!doctype html>
<html><body><h1>Users</h1><ul>${items}</ul></body></html>`);
});

app.get("/users/:id", (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.notFound();
  const user = USERS.find((u) => u.id === id);
  if (user) {
    return c.html(`<!doctype html>
<html><body><h1>${user.name}</h1><p>${user.email}</p></body></html>`);
  }
  // BUG-1: v2 has an off-by-one — IDs 11..15 hit a "still in range" branch
  // that throws a 500 instead of returning the expected 404.
  if (VARIANT === "v2" && id >= 11 && id <= 15) {
    throw new Error("v2 off-by-one: id ${id} treated as in-range");
  }
  return c.notFound();
});

// BUG-5: v2's cache policy on /api/* is stricter (no-store vs max-age=60).
// Either could be the "intended" policy — the point is the divergence,
// which parity --check-headers must surface as a header mismatch.
function apiCache(): string {
  return VARIANT === "v2" ? "no-store" : "max-age=60";
}

app.get("/api/users", async (c) => {
  // BUG-9: v2 adds latency that doesn't move any other dimension.
  if (VARIANT === "v2") await new Promise((r) => setTimeout(r, 120));
  c.header("cache-control", apiCache());
  return c.json(USERS);
});

// BUG-7: v1's POST persists, v2's POST returns success and discards.
// Status + body shape are identical on the write step — only the
// follow-up read (different state) surfaces the divergence.
interface Todo {
  id: number;
  title: string;
}
const TODOS: Todo[] = [];
let nextTodoId = 1;

app.post("/api/todos", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const created: Todo = { id: nextTodoId++, title: body.title ?? "untitled" };
  // BUG-7 is gated on the title to avoid colliding with BUG-8 (which
  // needs the write to actually persist so the GET-by-id can find it).
  // Real-world equivalent: a tenant-specific flag that drops certain
  // record classes silently.
  const dropOnV2 = (body.title ?? "").startsWith("drop:");
  if (!(VARIANT === "v2" && dropOnV2)) TODOS.push(created);
  c.header("cache-control", apiCache());
  return c.json(created, 201);
});

app.get("/api/todos", (c) => {
  c.header("cache-control", apiCache());
  return c.json(TODOS);
});

// BUG-10: per-user document store. v1 keys by the `u=<user>` session
// cookie. v2 has a bug where the listing endpoint ignores the cookie
// and returns the global pile — a tenant-isolation breach.
const DOCS_BY_USER = new Map<string, Array<{ title: string }>>();
function currentUser(c: { req: { header: (name: string) => string | undefined } }): string {
  const cookieHeader = c.req.header("cookie") ?? "";
  const match = cookieHeader.match(/u=([^;]+)/);
  return match ? match[1] : "anon";
}

app.post("/api/session", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { user?: string };
  const user = body.user ?? "anon";
  c.header("set-cookie", `u=${user}; Path=/; SameSite=Lax`);
  return c.json({ user });
});

app.post("/api/docs", async (c) => {
  const user = currentUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const list = DOCS_BY_USER.get(user) ?? [];
  list.push({ title: body.title ?? "untitled" });
  DOCS_BY_USER.set(user, list);
  return c.json({ ok: true }, 201);
});

app.get("/api/docs", (c) => {
  const user = currentUser(c);
  if (VARIANT === "v2") {
    // Bug: ignore the user, return all docs across all users.
    const all: Array<{ title: string }> = [];
    for (const docs of DOCS_BY_USER.values()) all.push(...docs);
    return c.json(all);
  }
  return c.json(DOCS_BY_USER.get(user) ?? []);
});

// BUG-8: GET by id returns a mutated title on v2. The POST is identical
// across variants and BUG-7 doesn't fire on v1 (which persists), so a
// journey that captures the id and reads it back is the only way to
// see this.
app.get("/api/todos/:id", (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  const todo = TODOS.find((t) => t.id === id);
  c.header("cache-control", apiCache());
  if (!todo) return c.notFound();
  if (VARIANT === "v2") return c.json({ ...todo, title: todo.title.toUpperCase() });
  return c.json(todo);
});

app.get("/api/users/:id", (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  const user = USERS.find((u) => u.id === id);
  if (!user) return c.notFound();
  c.header("cache-control", apiCache());
  // BUG-2: v2 strips the `email` field on /api/users/2 specifically.
  if (VARIANT === "v2" && id === 2) {
    const { email: _drop, ...rest } = user;
    return c.json(rest);
  }
  return c.json(user);
});

app.get("/admin", (c) => {
  // BUG-3: v2 inlines a script that references an undeclared variable.
  // Browsers raise a ReferenceError → chaosbringer captures it as a
  // console error → it forms a v2-only cluster the diff surfaces.
  const bugScript =
    VARIANT === "v2"
      ? `<script>console.log("admin loaded:", missingGlobalVariable);</script>`
      : "";
  return c.html(`<!doctype html>
<html><body><h1>Admin</h1>${bugScript}</body></html>`);
});

// BUG-6: byte-identical HTML on /dashboard for both variants — the only
// difference lives in /static/bundle.js, which v2 ships with a broken
// build (an undefined symbol). The HTTP-layer probes (status / headers
// / body bytes) all match for /dashboard. The browser-level probe
// catches it because the script throws on load.
app.get("/dashboard", (c) =>
  c.html(`<!doctype html>
<html><body><h1>Dashboard</h1><script src="/static/bundle.js"></script></body></html>`),
);

app.get("/static/bundle.js", (c) => {
  c.header("content-type", "application/javascript");
  return c.body(
    VARIANT === "v2"
      ? // BUG-6 v2: uncaught ReferenceError on load. The HTML referencing
        // bundle.js is identical on both sides, so this surfaces ONLY
        // through a browser visit + page-error capture.
        `(function(){ console.log('dashboard init:', undefinedDashboardSymbol); })();`
      : `(function(){ /* dashboard ready */ })();`,
  );
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[${VARIANT}] listening on http://127.0.0.1:${info.port} — chaos config:`,
    Object.keys(loadChaosConfig()).join(", "),
  );
});
