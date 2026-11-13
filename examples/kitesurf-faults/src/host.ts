/**
 * Host Worker: Kitesurf, embedded through its public `@kitesurf/engine/embed`
 * surface, with every outbound request of a CDP connection running through a
 * `@mizchi/kitesurf-faults` session owned by a test run.
 *
 * The wiring follows the constraints the connection spike measured on a real
 * workerd (see README.md):
 *
 * - `EngineHost.egress` has to return something that fits in Worker props, so
 *   it returns a Service Binding, `ctx.exports.ChaosEgress({props: {runId}})`.
 *   A plain object with a `fetch` closure cannot be cloned into the page
 *   isolate. The session itself stays in this isolate's memory (registry.ts)
 *   and the binding carries only the run id.
 * - `egress(env, ctx)` is told neither the request nor the connection, so the
 *   run is chosen at the WebSocket upgrade: `/devtools/browser?run=<id>`. No
 *   run, no connection (400); an unknown or disposed run, or one that
 *   already had a connection, is refused (409). There is no path where a
 *   connection runs without a session, or shares one with another.
 * - The engine creates egress once per connection and keeps it across
 *   navigations, so one run's counters span every page of its connection,
 *   and two connections never share counters or an RNG.
 * - `ChaosEgress` keeps no state on the instance: workerd may create one per
 *   call. Everything is looked up from the run id on each call.
 */

import {
  DEFAULT_ENGINE_HOST,
  DeniedOutbound,
  type EngineHost,
  KitesurfEngine,
  PageScriptTail,
  SandboxOutbound,
  SpanSink,
} from "@kitesurf/engine/embed";
import { createFaultEgress, type FaultEgressSession, KitesurfFaultsError } from "@mizchi/kitesurf-faults";
import { WorkerEntrypoint } from "cloudflare:workers";
import { CONTROL_PREFIX, decodeRules, handleControl } from "./control.js";
import { fixture } from "./fixture.js";
import { CALLER_CANCELLED_MARKER } from "./log-gate.js";
import { RunRegistry } from "./registry.js";

// The engine looks these up by name on `ctx.exports`; an embedder must
// export them from its main module.
export { DeniedOutbound, PageScriptTail, SandboxOutbound, SpanSink };

interface HostEnv {
  CHAOS_CONTROL_TOKEN?: string;
}

const registry = new RunRegistry<FaultEgressSession>();

/** The Service Binding the engine calls in place of `fetch`, after its own policy. */
export class ChaosEgress extends WorkerEntrypoint<HostEnv, { runId: string }> {
  override fetch(request: Request): Promise<Response> {
    const runId = this.ctx.props?.runId;
    const entry = runId ? registry.get(runId) : undefined;
    // Loud on purpose: a fresh session or a pass-through here would turn a
    // lost run into a green one.
    if (!entry || entry.disposed) throw new Error(`run-lost: ${runId}`);
    // Not `async`, and no `finally`: the count goes up at call time and down
    // in the settle callbacks, which run even when workerd cancels the
    // caller's context (with enable_request_signal) while a `finally` after
    // an await may not.
    entry.inFlight++;
    return entry.session.fetch(request).then(
      (response) => {
        entry.inFlight--;
        return response;
      },
      (error: unknown) => {
        entry.inFlight--;
        // The caller is gone, so nobody reads this rejection, but workerd
        // logs it, and the session's reason for it (the caller's abort
        // reason) prints as an empty `Uncaught`. Counted and renamed so the
        // log gate can tell it from an unexplained error.
        if (request.signal?.aborted && !(error instanceof KitesurfFaultsError)) {
          entry.callerCancelled++;
          throw new Error(`${CALLER_CANCELLED_MARKER} (run ${runId})`);
        }
        throw error;
      },
    );
  }
}

type ExportsCtx = { exports: { ChaosEgress(options: { props: { runId: string } }): Fetcher } };

export default class ChaosHost extends KitesurfEngine {
  #runId: string | undefined;

  protected override host(): EngineHost {
    const runId = this.#runId;
    // Only reached for requests that are not a CDP upgrade (health, assets):
    // `fetch` below refuses an upgrade without a run.
    if (!runId) return DEFAULT_ENGINE_HOST;
    return {
      ...DEFAULT_ENGINE_HOST,
      egress: (_env, ctx) => (ctx as unknown as ExportsCtx).exports.ChaosEgress({ props: { runId } }),
      // The only signal of a connection ending. Recorded for the harness,
      // which checks it after closing a socket; disposal stays the harness's
      // job, in its own finally.
      telemetry: (init) => ({
        emit(event) {
          if (event.name !== "session_end") return;
          registry.get(runId)?.sessionEnds.push({
            connectionId: init.meta.sessionId,
            at: Date.now(),
            endReason: event.fields?.endReason,
            closeCode: event.fields?.closeCode,
          });
        },
      }),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(CONTROL_PREFIX)) {
      return handleControl(request, (this.env as HostEnv).CHAOS_CONTROL_TOKEN, registry, (body, entry) =>
        createFaultEgress(
          {
            fetch: (req: Request) => {
              // Counted at call time, before the fixture runs: this is the
              // number of times the "real server" was asked.
              const path = new URL(req.url).pathname;
              entry.upstream[path] = (entry.upstream[path] ?? 0) + 1;
              return Promise.resolve(fixture(req));
            },
          },
          { rules: decodeRules(body.rules), seed: body.seed, maxDelayMs: body.maxDelayMs },
        ),
      );
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const runId = url.searchParams.get("run");
      if (!runId) return new Response("kitesurf-faults example: ?run=<id> is required", { status: 400 });
      const bound = registry.connect(runId);
      if (!bound.ok) return new Response(bound.error, { status: bound.status });
      this.#runId = runId;
    }
    return super.fetch(request);
  }
}
