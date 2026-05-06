/**
 * Tiny Hono todo app + chaos middleware.
 *
 * - `GET /` and `GET /todos/:id` serve the UI a chaosbringer crawl can navigate.
 * - `GET/POST/DELETE /api/todos` is the JSON API; chaos middleware applies here.
 * - The chaos middleware emits `x-chaos-fault-*` response headers, which the
 *   chaosbringer crawler parses and surfaces on `report.serverFaults`.
 *
 * Storage is an in-memory Map for this example. Real apps would use KV /
 * D1 / Durable Objects.
 *
 * The app + chaos middleware are constructed once per isolate and cached.
 * If we re-built per request, every request would see the SAME first roll
 * of a fresh seeded RNG (because `serverFaults({ seed })` is constructed
 * each time), and faults would fire either always or never depending on
 * that one roll. Module-level caching lets the RNG advance across requests
 * within an isolate, which is the only context where reproducibility is
 * meaningful anyway.
 */

import { Hono } from "hono";
import { honoMiddleware } from "@mizchi/server-faults/hono";
import type { Env } from "./types.js";

interface Todo {
  id: string;
  title: string;
  done: boolean;
}

// Simple in-memory store. A new Worker isolate per request would drop this;
// in `wrangler dev` the same isolate is reused, so the demo state persists.
const TODOS = new Map<string, Todo>();
let nextId = 1;

let cachedApp: Hono<{ Bindings: Env }> | null = null;
let cachedEnvKey: string | null = null;

function envKey(env: Env): string {
  return [
    env.DEPLOY_ENV ?? "",
    env.CHAOS_5XX_RATE ?? "",
    env.CHAOS_LATENCY_RATE ?? "",
    env.CHAOS_LATENCY_MS ?? "",
    env.CHAOS_SEED ?? "",
  ].join("|");
}

export function createApp(env: Env) {
  const key = envKey(env);
  if (cachedApp && cachedEnvKey === key) return cachedApp;
  cachedEnvKey = key;
  cachedApp = buildApp(env);
  return cachedApp;
}

function buildApp(env: Env): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Mount server-faults BEFORE the routes so it can short-circuit before the
  // handler runs. metadataHeader: true is the load-bearing flag — it makes
  // chaosbringer's `server: { mode: "remote" }` mode see the fault events.
  const r5 = Number(env.CHAOS_5XX_RATE ?? "0");
  const rL = Number(env.CHAOS_LATENCY_RATE ?? "0");
  if (env.DEPLOY_ENV === "dev" && (r5 > 0 || rL > 0)) {
    app.use(
      "/api/*",
      honoMiddleware({
        status5xxRate: r5,
        latencyRate: rL,
        latencyMs: Number(env.CHAOS_LATENCY_MS ?? "0"),
        seed: env.CHAOS_SEED ? Number(env.CHAOS_SEED) : undefined,
        metadataHeader: true,
        bypassHeader: "x-chaos-bypass",
        observer: {
          onFault: (kind, attrs) => {
            console.log(`[chaos] ${kind} ${attrs.method} ${attrs.path} traceId=${attrs.traceId ?? "-"}`);
          },
        },
      }),
    );
  }

  // ---------- API ----------
  app.get("/api/todos", (c) => c.json({ items: [...TODOS.values()] }));

  app.post("/api/todos", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    if (!body.title) return c.json({ error: "title required" }, 400);
    const id = String(nextId++);
    const todo: Todo = { id, title: body.title, done: false };
    TODOS.set(id, todo);
    return c.json(todo, 201);
  });

  app.delete("/api/todos/:id", (c) => {
    const id = c.req.param("id");
    if (!TODOS.has(id)) return c.json({ error: "not found" }, 404);
    TODOS.delete(id);
    return c.json({ ok: true });
  });

  // ---------- UI ----------
  app.get("/", (c) =>
    c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Todo demo</title>
</head>
<body>
  <h1>Todos</h1>
  <ul id="list"><li>loading...</li></ul>
  <button id="add">Add random todo</button>
  <p><a href="/about">About</a></p>
  <script type="module">
    const list = document.getElementById("list");
    async function refresh() {
      list.innerHTML = "<li>loading...</li>";
      try {
        const r = await fetch("/api/todos");
        if (!r.ok) throw new Error("fetch failed: " + r.status);
        const data = await r.json();
        list.innerHTML = data.items.length
          ? data.items.map(t => \`<li><a href="/todos/\${t.id}">\${t.title}</a></li>\`).join("")
          : "<li>(none yet)</li>";
      } catch (err) {
        list.innerHTML = "<li>error: " + err.message + "</li>";
      }
    }
    document.getElementById("add").addEventListener("click", async () => {
      await fetch("/api/todos", { method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ title: "todo-" + Date.now() }) });
      refresh();
    });
    refresh();
  </script>
</body>
</html>`),
  );

  app.get("/todos/:id", (c) => {
    const id = c.req.param("id");
    return c.html(`<!doctype html>
<title>Todo ${id}</title>
<h1>Todo ${id}</h1>
<p><a href="/">back</a></p>`);
  });

  app.get("/about", (c) =>
    c.html(`<!doctype html><title>About</title><h1>About</h1>
<p>Demo app showing chaosbringer + @mizchi/server-faults orchestration.</p>
<p><a href="/">home</a></p>`),
  );

  return app;
}
