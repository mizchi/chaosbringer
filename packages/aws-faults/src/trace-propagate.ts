/**
 * Trace propagation for AWS-SDK-v3 clients (issue #115).
 *
 * The rehearsal harness is most useful when scoring can answer "which
 * chaos rule fired on which customer journey iteration." For that
 * answer to exist, the journey's trace ID must travel:
 *
 *   browser fetch -> target HTTP handler -> AWS SDK call -> kumo
 *
 * The kumo side records the inbound `traceparent` (or `X-Kumo-Trace`)
 * against the matched rule. This module owns the two middle links:
 *
 *   - `honoTraceContext(c, next)`: Hono middleware that stashes the
 *     inbound `traceparent` in AsyncLocalStorage for the duration of
 *     the request.
 *   - `attachTracePropagation(client)`: SDK-v3 client middleware that
 *     reads from that ALS and writes the trace value as a header on
 *     every outgoing AWS call.
 *
 * Together they pass a trace ID through the target with no per-call
 * code changes. If no header was on the inbound request, nothing is
 * propagated (kumo silently drops empty traces).
 */
import { AsyncLocalStorage } from "node:async_hooks";

const traceStore = new AsyncLocalStorage<string>();

/** Returns the trace value currently in scope, or undefined. */
export function currentTrace(): string | undefined {
  return traceStore.getStore();
}

/**
 * Run `fn` with the given trace value in scope. Any AWS SDK client
 * with `attachTracePropagation()` installed will read it.
 */
export function runWithTrace<T>(trace: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!trace) return fn();
  return traceStore.run(trace, fn);
}

interface HonoLikeContext {
  req: { header: (name: string) => string | undefined };
}

/**
 * Hono middleware. Reads `traceparent` / `X-Kumo-Trace` off the
 * inbound request and runs the rest of the handler chain with that
 * value in ALS. Pass as `app.use("*", honoTraceContext)`.
 */
export const honoTraceContext = async (
  c: HonoLikeContext,
  next: () => Promise<unknown>,
): Promise<unknown> => {
  const trace = c.req.header("traceparent") ?? c.req.header("X-Kumo-Trace") ?? "";
  return runWithTrace(trace, async () => {
    await next();
  });
};

/**
 * Minimal shape needed from an AWS-SDK-v3 client: just the
 * middlewareStack. Avoids dragging in a hard dep on @smithy/types.
 */
interface ClientLike {
  middlewareStack: {
    add: (
      middleware: (
        next: (args: { request?: unknown; [k: string]: unknown }) => Promise<unknown>,
      ) => (args: { request?: unknown; [k: string]: unknown }) => Promise<unknown>,
      options: { step: "build"; name: string; override?: boolean },
    ) => void;
  };
}

/**
 * Install a build-step middleware on an AWS-SDK-v3 client that writes
 * the current ALS trace value as a `traceparent` header on every
 * outgoing request. Safe to call multiple times — `override: true`
 * replaces an existing instance.
 */
export function attachTracePropagation(client: ClientLike): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const trace = currentTrace();
      const req = args.request as { headers?: Record<string, string> } | undefined;
      if (trace && req && typeof req === "object" && req.headers && typeof req.headers === "object") {
        req.headers["traceparent"] = trace;
      }
      return next(args);
    },
    { step: "build", name: "kumo-trace-propagate", override: true },
  );
}
