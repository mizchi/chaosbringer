import fs from "node:fs";
import type { CDPSession } from "playwright";
import { CSS_STATS } from "./config";
import {
  summarizeInitiator,
  type NetReq,
  type CdpInitiator,
} from "./analyze/network";
import type { TraceEvent } from "./analyze/render";

// ---------------------------------------------------------------------------
// CDP network capture (epoch ms).
// requestWillBeSent carries both timestamp (monotonic s) and wallTime (epoch s).
// loadingFinished carries timestamp (monotonic s) only, hence:
//   startEpochMs = wallTime * 1000
//   endEpochMs   = startEpochMs + (endMono - startMono) * 1000
// The NetReq record shape and its summarizer live in ./analyze/network.
// ---------------------------------------------------------------------------

export async function startNetworkCapture(
  client: CDPSession,
): Promise<() => NetReq[]> {
  const reqs = new Map<string, NetReq>();
  await client.send("Network.enable");

  client.on("Network.requestWillBeSent", (e) => {
    const p = e as unknown as {
      requestId: string;
      request: { url: string };
      type?: string;
      timestamp: number;
      wallTime: number;
      initiator?: CdpInitiator;
    };
    reqs.set(p.requestId, {
      url: p.request.url,
      type: p.type ?? "Other",
      startMono: p.timestamp,
      startEpochMs: p.wallTime * 1000,
      initiator: summarizeInitiator(p.initiator),
    });
  });
  client.on("Network.responseReceived", (e) => {
    const p = e as unknown as {
      requestId: string;
      type?: string;
      response?: {
        fromDiskCache?: boolean;
        fromPrefetchCache?: boolean;
        fromServiceWorker?: boolean;
      };
    };
    const r = reqs.get(p.requestId);
    if (!r) return;
    if (p.type) r.type = p.type;
    if (
      p.response?.fromDiskCache ||
      p.response?.fromPrefetchCache ||
      p.response?.fromServiceWorker
    )
      r.fromCache = true;
  });
  // memory-cache hits don't carry a response body; they fire this instead
  client.on("Network.requestServedFromCache", (e) => {
    const p = e as unknown as { requestId: string };
    const r = reqs.get(p.requestId);
    if (r) r.fromCache = true;
  });
  client.on("Network.loadingFinished", (e) => {
    const p = e as unknown as {
      requestId: string;
      timestamp: number;
      encodedDataLength: number;
    };
    const r = reqs.get(p.requestId);
    if (r) {
      r.endEpochMs = r.startEpochMs + (p.timestamp - r.startMono) * 1000;
      r.encoded = p.encodedDataLength;
    }
  });

  return () => [...reqs.values()];
}

// ---------------------------------------------------------------------------
// Chrome trace capture (opt-in)
// ---------------------------------------------------------------------------

export async function startTrace(
  client: CDPSession,
  tracePath: string,
  cssStats: boolean = CSS_STATS,
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
