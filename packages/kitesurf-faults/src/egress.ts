/**
 * `FaultRule`s run on a `fetch(request)` transport.
 *
 * The session sits where Kitesurf calls its host's egress: after the engine
 * has applied its URL filter, CORS, cookies and private-network checks, and
 * before the request leaves the Worker. So a fault here is a fault in the
 * network, not a hole in the engine's policy, and a request the engine
 * refuses never gets this far.
 *
 * The rule decision is `@mizchi/playwright-faults/network`'s, the same one
 * chaosbringer's Playwright route handler uses: same first-match order, same
 * occurrence counters, same mulberry32 draws for a seed.
 */

import {
  compileFaultRules,
  createRng,
  DEFAULT_STATUS_CONTENT_TYPE,
  faultStatsOf,
  faultStatusBody,
  pickFaultRule,
} from "@mizchi/playwright-faults/network";
import { INJECTED_ABORT_MARKER, KitesurfFaultsError } from "./errors.js";
import type { FaultEgressOptions, FaultEgressSession, FetchTransport } from "./types.js";
import { checkOptions } from "./validate.js";

export { DEFAULT_MAX_DELAY_MS, MAX_DELAY_CAP_MS } from "./validate.js";

const disposedError = () =>
  new KitesurfFaultsError("disposed", "kitesurf-faults: the fault egress session is disposed");

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The request was aborted", "AbortError");

// Test-only view of each session's in-flight set, kept off the session object
// and out of index.ts so it is not part of the public API. A controller left
// in the set is invisible to callers until a long-lived run has piled them up.
const inFlightOf = new WeakMap<FaultEgressSession, Set<AbortController>>();

/** @internal Pending waits and upstream calls of `session`. */
export function inFlightCount(session: FaultEgressSession): number {
  return inFlightOf.get(session)?.size ?? 0;
}

/**
 * Wrap `upstream` so the rules in `options` decide what each request gets.
 *
 * Throws a `KitesurfFaultsError` with code `invalid-config` for anything the
 * transport cannot honour (see `validate.ts`). Rules are copied, compiled and
 * the RNG seeded once, here.
 */
export function createFaultEgress(upstream: FetchTransport, options: FaultEgressOptions): FaultEgressSession {
  if (typeof (upstream as Partial<FetchTransport> | null)?.fetch !== "function") {
    throw new KitesurfFaultsError("invalid-config", "kitesurf-faults: upstream must have a fetch(request) method");
  }
  const { rules, seed } = checkOptions(options);
  const compiled = compileFaultRules(rules, "kitesurf-faults");
  const rng = createRng(seed);

  // One controller per request in flight, created inside that request's call
  // rather than one session-wide signal shared by all of them. On workerd the
  // session is built in one request context and called from others; per-call
  // objects keep every timer, listener and signal in the context that uses
  // it, and dispose only has to call `abort()` on each.
  const inFlight = new Set<AbortController>();
  let disposed = false;

  /** Hand `request` to upstream once, abortable by the caller or by dispose. */
  function forward(request: Request): Promise<Response> {
    const call = new AbortController();
    inFlight.add(call);
    let pending: Promise<Response>;
    try {
      const signal = request.signal ? AbortSignal.any([request.signal, call.signal]) : call.signal;
      // A new Request only to attach the signal: URL, method, headers, body,
      // credentials and redirect are carried over from the original.
      const forwarded = new Request(request, { signal });
      pending = upstream.fetch(forwarded);
    } catch (error) {
      // A synchronous throw (a Request whose body was already used, or an
      // upstream `fetch` that throws instead of rejecting) never reaches the
      // callbacks below, so the controller has to leave the set here.
      inFlight.delete(call);
      return Promise.reject(disposed ? disposedError() : error);
    }
    // Settled in the callbacks themselves, not in a `finally`: workerd can
    // cancel a call's context without running anything after the await.
    return pending.then(
      (res) => {
        inFlight.delete(call);
        if (disposed) {
          // This session owns a Response it will not hand out; cancel the body
          // so the connection behind it is released.
          res.body?.cancel().catch(() => {});
          throw disposedError();
        }
        return res;
      },
      (error: unknown) => {
        inFlight.delete(call);
        throw disposed ? disposedError() : error;
      },
    );
  }

  /** Resolve after `ms`, or reject on the caller's abort or on dispose. */
  function wait(ms: number, request: Request): Promise<void> {
    const call = new AbortController();
    inFlight.add(call);
    const signals = request.signal ? [request.signal, call.signal] : [call.signal];
    return new Promise<void>((resolve, reject) => {
      // Timer and listeners are removed by whichever of the three fires,
      // inside the callback: a `finally` might never run (see above), and a
      // listener left on the caller's signal outlives the request.
      const settle = () => {
        clearTimeout(timer);
        for (const s of signals) s.removeEventListener("abort", onAbort);
        inFlight.delete(call);
      };
      const onAbort = () => {
        settle();
        reject(call.signal.aborted ? disposedError() : abortReason(request.signal));
      };
      const timer = setTimeout(() => {
        settle();
        resolve();
      }, ms);
      for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
    });
  }

  const session: FaultEgressSession = {
    // `async`, but nothing before the first `await` is: the rule is picked and
    // the counters advanced at call time, so concurrent requests take their
    // occurrence numbers in arrival order whatever their delays.
    async fetch(request: Request): Promise<Response> {
      if (disposed) throw disposedError();
      // Already cancelled: the request never happened, so it is not counted.
      if (request.signal?.aborted) throw abortReason(request.signal);

      const winner = pickFaultRule(compiled, request.url, request.method.toUpperCase(), rng);
      if (!winner) return forward(request);

      const fault = winner.rule.fault;
      switch (fault.kind) {
        case "status":
          // A response built here; nothing upstream failed and no server span
          // exists for it.
          return new Response(faultStatusBody(fault), {
            status: fault.status,
            headers: { "content-type": fault.contentType ?? DEFAULT_STATUS_CONTENT_TYPE },
          });
        case "abort":
          // A rejection, as a network failure is to `fetch`: not a 5xx.
          throw new KitesurfFaultsError("injected-abort", INJECTED_ABORT_MARKER);
        case "delay":
          await wait(fault.ms, request);
          return forward(request);
        default:
          // `validate.ts` refuses every other kind at construction.
          throw new KitesurfFaultsError("invalid-config", `kitesurf-faults: unsupported fault kind ${fault.kind}`);
      }
    },

    stats() {
      return faultStatsOf(compiled);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Synchronous: every pending wait rejects and every upstream signal
      // fires now. Upstream is not awaited; a Response that still arrives is
      // cancelled in `forward`.
      for (const call of inFlight) call.abort(disposedError());
      inFlight.clear();
    },
  };
  inFlightOf.set(session, inFlight);
  return session;
}
