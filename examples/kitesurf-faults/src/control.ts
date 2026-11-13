/**
 * The control plane: create a run, read its stats, dispose it, delete it.
 *
 * Only the test harness may use it. It answers on the host Worker's own
 * address and requires `x-chaos-control-token` to equal
 * `CHAOS_CONTROL_TOKEN`, a random value the runner generates per run and
 * passes to `wrangler dev --var`; an empty token turns the control plane
 * off. A page cannot get here at all: its requests go through the engine to
 * egress and the in-isolate fixture, and a page fetch of the host's
 * 127.0.0.1 address is refused by the engine's private-network check. The
 * token is a second lock, against anything else on the machine.
 *
 *   POST /__chaos/create            {runId, rules, seed, maxDelayMs?}
 *   GET  /__chaos/stats?run=<id>
 *   POST /__chaos/dispose?run=<id>  idempotent
 *   POST /__chaos/delete?run=<id>   dispose and forget; the id is run-lost after
 */

import type { FaultEgressSession, FaultRule } from "@mizchi/kitesurf-faults";
import type { RunEntry, RunRegistry } from "./registry.js";

export const CONTROL_PREFIX = "/__chaos/";
export const CONTROL_TOKEN_HEADER = "x-chaos-control-token";

/** JSON cannot carry a RegExp; a rule may send `{source, flags}` instead. */
type WireRule = Omit<FaultRule, "urlPattern"> & { urlPattern: string | { source: string; flags?: string } };

export interface CreateBody {
  runId: string;
  rules: WireRule[];
  seed: number;
  maxDelayMs?: number;
}

export function decodeRules(rules: unknown): FaultRule[] {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  return rules.map((r: WireRule) => {
    const p = r?.urlPattern;
    if (p && typeof p === "object" && typeof p.source === "string") {
      return { ...r, urlPattern: new RegExp(p.source, p.flags ?? "") };
    }
    return r as FaultRule;
  });
}

export function snapshot(entry: RunEntry<FaultEgressSession>) {
  return {
    runId: entry.id,
    createdAt: entry.createdAt,
    disposed: entry.disposed,
    connected: entry.connected,
    stats: entry.session.stats(),
    upstream: { ...entry.upstream },
    inFlight: entry.inFlight,
    disposedInFlight: entry.disposedInFlight,
    callerCancelled: entry.callerCancelled,
    sessionEnds: entry.sessionEnds.map((s) => ({ ...s })),
  };
}

const text = (status: number, body: string) => new Response(body, { status });

export async function handleControl(
  request: Request,
  token: string | undefined,
  registry: RunRegistry<FaultEgressSession>,
  makeSession: (body: CreateBody, entry: Omit<RunEntry<FaultEgressSession>, "session">) => FaultEgressSession,
): Promise<Response> {
  if (!token || request.headers.get(CONTROL_TOKEN_HEADER) !== token) return text(403, "control plane: bad or missing token");

  const url = new URL(request.url);
  const op = url.pathname.slice(CONTROL_PREFIX.length);

  if (op === "create" && request.method === "POST") {
    let body: CreateBody;
    try {
      body = (await request.json()) as CreateBody;
    } catch {
      return text(400, "create: body must be JSON");
    }
    const made = registry.create(String(body?.runId ?? ""), (entry) => makeSession(body, entry));
    if (!made.ok) return text(made.status, made.error);
    return Response.json(snapshot(made.entry));
  }

  const id = url.searchParams.get("run") ?? "";
  if (op === "stats" && request.method === "GET") {
    const entry = registry.get(id);
    return entry ? Response.json(snapshot(entry)) : text(404, `run-lost: ${id}`);
  }
  if ((op === "dispose" || op === "delete") && request.method === "POST") {
    const entry = op === "dispose" ? await registry.dispose(id) : await registry.delete(id);
    return entry ? Response.json(snapshot(entry)) : text(404, `run-lost: ${id}`);
  }
  return text(400, `control plane: unknown operation ${request.method} ${op}`);
}
