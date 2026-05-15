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

app.get("/api/users", (c) => c.json(USERS));

app.get("/api/users/:id", (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  const user = USERS.find((u) => u.id === id);
  if (!user) return c.notFound();
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    `[${VARIANT}] listening on http://127.0.0.1:${info.port} — chaos config:`,
    Object.keys(loadChaosConfig()).join(", "),
  );
});
