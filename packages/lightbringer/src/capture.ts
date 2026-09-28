import fs from "node:fs";
import type { CDPSession } from "playwright";
import {
  summarizeInitiator,
  type NetReq,
  type CdpInitiator,
} from "./analyze/network";
import type { TraceEvent } from "./analyze/render";
import {
  cdpEndpoint,
  childTargets,
  type CdpEndpoint,
  type ChildTarget,
} from "./targets";

// ---------------------------------------------------------------------------
// CDP network capture (epoch ms).
// requestWillBeSent carries both timestamp (monotonic s) and wallTime (epoch s).
// loadingFinished carries timestamp (monotonic s) only, hence:
//   startEpochMs = wallTime * 1000
//   endEpochMs   = startEpochMs + (endMono - startMono) * 1000
// The NetReq record shape and its summarizer live in ./analyze/network.
//
// Events come from the page's session and from each out-of-process iframe's
// target (./targets). The monotonic clock is the browser's, shared by every
// target, so the arithmetic above holds across them.
// ---------------------------------------------------------------------------

/** The scope of the page's own session in a {@link NetworkRecorder}. */
export const PAGE_SCOPE = "";

/**
 * Pure store of CDP Network events from one or more targets. `scope` names
 * the target an event came from ({@link PAGE_SCOPE} for the page's session, a
 * child's sessionId otherwise): requestIds are only unique per target — a
 * renderer numbers its own requests — so records are keyed by scope and
 * requestId.
 *
 * The one id shared across targets is a navigation's: an OOPIF's document
 * request is sent from the parent's target (its `requestWillBeSent` is on the
 * parent's session) but its body is streamed into the iframe's own process, so
 * `loadingFinished` for the same requestId arrives on the child's target. An
 * event whose requestId is unknown in its own scope therefore completes the
 * latest Document request with that id from any scope.
 */
export class NetworkRecorder {
  private readonly reqs = new Map<string, NetReq>();
  /** latest Document request by bare requestId (navigation ids are browser-wide) */
  private readonly documents = new Map<string, NetReq>();

  /** Feed one CDP event (`Network.*`); others are ignored. */
  handle(scope: string, method: string, params: unknown): void {
    switch (method) {
      case "Network.requestWillBeSent": {
        const p = params as {
          requestId: string;
          request: { url: string };
          type?: string;
          timestamp: number;
          wallTime: number;
          initiator?: CdpInitiator;
        };
        // A redirect re-sends the same requestId: the chain is one request
        // (its last hop), as it always was.
        const r: NetReq = {
          url: p.request.url,
          type: p.type ?? "Other",
          startMono: p.timestamp,
          startEpochMs: p.wallTime * 1000,
          initiator: summarizeInitiator(p.initiator),
        };
        this.reqs.set(key(scope, p.requestId), r);
        if (r.type === "Document") this.documents.set(p.requestId, r);
        return;
      }
      case "Network.responseReceived": {
        const p = params as {
          requestId: string;
          type?: string;
          response?: {
            fromDiskCache?: boolean;
            fromPrefetchCache?: boolean;
            fromServiceWorker?: boolean;
          };
        };
        const r = this.find(scope, p.requestId);
        if (!r) return;
        if (p.type) r.type = p.type;
        if (
          p.response?.fromDiskCache ||
          p.response?.fromPrefetchCache ||
          p.response?.fromServiceWorker
        )
          r.fromCache = true;
        return;
      }
      // memory-cache hits don't carry a response body; they fire this instead
      case "Network.requestServedFromCache": {
        const r = this.find(scope, (params as { requestId: string }).requestId);
        if (r) r.fromCache = true;
        return;
      }
      case "Network.loadingFinished": {
        const p = params as {
          requestId: string;
          timestamp: number;
          encodedDataLength: number;
        };
        const r = this.find(scope, p.requestId);
        if (r) {
          r.endEpochMs = r.startEpochMs + (p.timestamp - r.startMono) * 1000;
          r.encoded = p.encodedDataLength;
        }
        return;
      }
      // A failed / aborted request (a fault's abort, a navigation cancelling an
      // in-flight fetch) never gets `loadingFinished`. Its failure time is kept
      // apart from `endEpochMs`: the request did not complete, but it is no
      // longer running either.
      case "Network.loadingFailed": {
        const p = params as { requestId: string; timestamp: number };
        const r = this.find(scope, p.requestId);
        if (r && r.endEpochMs == null) {
          r.failedEpochMs = r.startEpochMs + (p.timestamp - r.startMono) * 1000;
        }
        return;
      }
    }
  }

  /** Every request so far, in the order they were first sent. */
  requests(): NetReq[] {
    return [...this.reqs.values()];
  }

  private find(scope: string, requestId: string): NetReq | undefined {
    return this.reqs.get(key(scope, requestId)) ?? this.documents.get(requestId);
  }
}

function key(scope: string, requestId: string): string {
  // sessionIds and requestIds never contain a space
  return `${scope} ${requestId}`;
}

const NETWORK_EVENTS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.requestServedFromCache",
  "Network.loadingFinished",
  "Network.loadingFailed",
] as const;

export interface NetworkCapture {
  /** snapshot of every request so far (stops nothing) */
  requests(): NetReq[];
  /** stop listening, and leave the child targets (see startNetworkCapture) */
  stop(): Promise<void>;
}

export interface NetworkCaptureOptions {
  /**
   * Also record out-of-process iframes' requests, from their own targets
   * (./targets). Default true. Off, only the page's session is read: under
   * site isolation an OOPIF then shows as its document request alone.
   */
  childTargets?: boolean;
  /**
   * Called for each child target once its Network domain is on, before it
   * runs — for the session to apply the same emulation it applies to the page.
   */
  onChild?: (child: ChildTarget) => Promise<void>;
}

export async function startNetworkCapture(
  client: CDPSession,
  opts: NetworkCaptureOptions = {},
): Promise<NetworkCapture> {
  const recorder = new NetworkRecorder();
  const page = cdpEndpoint(client);
  const offs: Array<() => void> = [];
  const listen = (source: CdpEndpoint, scope: string) => {
    for (const ev of NETWORK_EVENTS) {
      const fn = (p: unknown) => recorder.handle(scope, ev, p);
      source.on(ev, fn);
      offs.push(() => source.off(ev, fn));
    }
  };
  listen(page, PAGE_SCOPE);
  await client.send("Network.enable");

  let unsubscribe: (() => Promise<void>) | undefined;
  if (opts.childTargets !== false) {
    const seen = new Set<string>();
    unsubscribe = await childTargets(client).subscribe({
      attached: async (child) => {
        if (seen.has(child.sessionId)) return;
        seen.add(child.sessionId);
        listen(child, child.sessionId);
        await child.send("Network.enable");
        await opts.onChild?.(child);
      },
    });
  }

  let stopped = false;
  return {
    requests: () => recorder.requests(),
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const off of offs.splice(0)) off();
      await unsubscribe?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Chrome trace capture (opt-in)
// ---------------------------------------------------------------------------

export async function startTrace(
  client: CDPSession,
  tracePath: string,
  cssStats: boolean = false,
): Promise<() => Promise<{ renderEvents: TraceEvent[] }>> {
  // A heavy page emits tens-to-hundreds of MB of trace events. Holding them all
  // in a JS array and JSON.stringify-ing at the end peaks at 2x that in heap and
  // OOMs. Instead: stream every event straight to disk for the drilldown, and
  // keep in memory only the handful aggregation needs (Paint / GPUTask, used to
  // fill per-span paint/GPU). The drilldown reads the file when it needs the rest.
  const renderEvents: TraceEvent[] = [];
  const out = fs.createWriteStream(tracePath);
  out.write("[");
  let wroteAny = false;
  let writeError: Error | undefined;
  out.on("error", (err) => {
    writeError = err;
  });

  client.on("Tracing.dataCollected", (e) => {
    const p = e as unknown as { value: TraceEvent[] };
    const batch = p.value;
    // for-loop, NOT events.push(...batch): a single dataCollected batch can
    // exceed the spread-call argument limit (~120k) and throw RangeError, which
    // would lose the entire trace on exactly the heavy pages this is meant for.
    let chunk = "";
    for (let i = 0; i < batch.length; i++) {
      const ev = batch[i];
      chunk += (wroteAny ? "," : "") + JSON.stringify(ev);
      wroteAny = true;
      if (ev.ph === "X" && (ev.name === "Paint" || ev.name === "GPUTask")) {
        renderEvents.push(ev);
      }
    }
    if (chunk) out.write(chunk);
  });
  await client.send("Tracing.start", {
    transferMode: "ReportEvents",
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "blink.user_timing",
      "loading",
      "latencyInfo",
      "v8.execute",
      "gpu",
      "disabled-by-default-v8.cpu_profiler",
      // per-selector style-recalc match stats (SelectorStats); opt-in, expensive
      ...(cssStats ? ["disabled-by-default-blink.debug"] : []),
    ].join(","),
  });
  return async () => {
    const done = new Promise<void>((resolve) => {
      client.once("Tracing.tracingComplete", () => resolve());
    });
    await client.send("Tracing.end");
    await done;
    // close the JSON array and flush to disk before we read the file path back
    await new Promise<void>((resolve, reject) => {
      out.end("]", () => (writeError ? reject(writeError) : resolve()));
    });
    return { renderEvents };
  };
}
