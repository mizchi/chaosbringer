/**
 * Wire contract between `@mizchi/server-faults`' `metadataHeader` encoding
 * and `parseServerFaultHeaders`. The two packages share no types, only the
 * HTTP headers, so this drives every server-faults `FaultKind` through
 * server-faults' own raffle and header encoder and checks the parser gets
 * back exactly the attrs the server stamped. A kind or attr server-faults
 * gains fails here until the parser learns it.
 */
import { describe, expect, it } from "vitest";
import {
  attrsToHeaderEntries,
  FAULT_KINDS,
  type FaultKind,
  type FaultVerdict,
  type ServerFaultConfig,
  serverFaults,
} from "../../server-faults/src/server-faults.js";
import { parseServerFaultHeaders } from "./server-fault-events.js";

const PREFIX = "x-chaos-fault";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

// A config per kind whose raffle wins on the first request. Non-default and
// fractional values where the attr allows them, so a parser that drops or
// rounds a field cannot pass by coincidence.
const CONFIG: Record<FaultKind, ServerFaultConfig> = {
  "5xx": { status5xxRate: 1, status5xxCode: 502 },
  latency: { latencyRate: 1, latencyMs: 1.5 },
  abort: { abortRate: 1, abortStyle: "reset" },
  partial: { partialResponseRate: 1, partialResponseAfterBytes: 7 },
  slowStream: { slowStreaming: { rate: 1, chunkDelayMs: 12.5, chunkSize: 4 } },
};

type Verdict = NonNullable<FaultVerdict>;

async function inject(kind: FaultKind): Promise<Verdict> {
  const handle = serverFaults({ ...CONFIG[kind], metadataHeader: { prefix: PREFIX }, seed: 1 });
  const verdict = await handle.maybeInject(
    new Request("https://app.test/api/todos", {
      method: "post",
      headers: { traceparent: `00-${TRACE_ID}-b7ad6b7169203331-01` },
    }),
  );
  if (!verdict) throw new Error(`server-faults returned no verdict for ${kind}`);
  return verdict;
}

/** The fault headers on the response the browser receives. */
function wireHeaders(verdict: Exclude<Verdict, { kind: "abort" }>): Headers {
  // A synthetic response carries its own; on the other paths the real
  // handler's response is stamped by the adapter with the same encoder.
  if (verdict.kind === "synthetic") return verdict.response.headers;
  return new Headers(attrsToHeaderEntries(verdict.attrs, PREFIX));
}

describe("server-faults header contract", () => {
  it("has a config for every server-faults fault kind", () => {
    expect(Object.keys(CONFIG).sort()).toEqual([...FAULT_KINDS].sort());
  });

  it.each(FAULT_KINDS.filter((k) => k !== "abort"))("round-trips a %s fault", async (kind) => {
    const verdict = await inject(kind);
    if (verdict.kind === "abort") throw new Error(`${kind} produced an abort verdict`);
    expect(verdict.attrs.kind).toBe(kind);
    expect(parseServerFaultHeaders(wireHeaders(verdict), PREFIX)).toEqual({
      attrs: { ...verdict.attrs },
      traceId: TRACE_ID,
    });
  });

  it("abort has no response to carry headers, and the parser does not claim the kind", async () => {
    const verdict = await inject("abort");
    // No `response` (and the adapters tear the connection down instead of
    // answering): the observer is the only channel for an abort, so there is
    // nothing for the response listener to see.
    expect(verdict).toEqual({
      kind: "abort",
      abortStyle: "reset",
      attrs: {
        kind: "abort",
        path: "/api/todos",
        method: "POST",
        abortStyle: "reset",
        traceId: TRACE_ID,
      },
    });
    expect(
      parseServerFaultHeaders(new Headers(attrsToHeaderEntries(verdict.attrs, PREFIX)), PREFIX),
    ).toBeNull();
  });
});
