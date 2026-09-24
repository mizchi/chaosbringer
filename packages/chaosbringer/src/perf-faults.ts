/**
 * Perf under chaos: which faults were active during each span, and what they
 * cost.
 *
 * Pure. `SpanFaultTags` is the bookkeeping `PagePerf` does while a page is
 * visited — the crawler tells it when a fault fires, it knows which spans are
 * open — and `buildDegradation` is the crawl-wide comparison built from the
 * tagged spans in the report. Neither touches a browser, so both are unit
 * tested without one.
 */

import { median } from "lightbringer/core";
import type {
  PerfDegradationEntry,
  PerfDegradationSide,
  PerfSpanReport,
  ServerFaultEvent,
} from "./types.js";

/**
 * The faults of each open span of one page visit.
 *
 * A fault is tagged onto every span open when it fires. `persistent` faults
 * (lifecycle faults: a CPU throttle or wiped storage outlasts the stage that
 * applied it) are also tagged onto every span opened later in the visit, and
 * `pageFaults` (the crawl's runtime faults, whose script is on every page)
 * onto every span. `H` is whatever identifies a span to the caller.
 */
export class SpanFaultTags<H> {
  private readonly open = new Map<H, Set<string>>();
  private readonly persistent = new Set<string>();

  constructor(private readonly pageFaults: readonly string[] = []) {}

  /** A span opened: it starts with the page's and the persistent faults. */
  begin(handle: H): void {
    this.open.set(handle, new Set([...this.pageFaults, ...this.persistent]));
  }

  /** A fault fired: every open span saw it; a persistent one outlives them. */
  note(name: string, { persistent = false }: { persistent?: boolean } = {}): void {
    for (const tags of this.open.values()) tags.add(name);
    if (persistent) this.persistent.add(name);
  }

  /** The span closed (or was dropped): its faults, sorted; `undefined` when none. */
  end(handle: H): string[] | undefined {
    const tags = this.open.get(handle);
    this.open.delete(handle);
    return tags && tags.size > 0 ? [...tags].sort() : undefined;
  }
}

/**
 * The fault name a server-side fault event contributes to a span. By kind
 * only — `server:5xx`, `server:latency` — so every span the same kind of
 * server fault hit groups under one name in `degradation`.
 */
export function serverFaultName(event: Pick<ServerFaultEvent, "attrs">): string {
  return `server:${event.attrs.kind}`;
}

/** Merge `names` into `span.faults`, keeping it sorted and deduplicated. */
export function addSpanFaults(span: PerfSpanReport, names: Iterable<string>): void {
  const all = new Set([...(span.faults ?? []), ...names]);
  if (all.size > 0) span.faults = [...all].sort();
}

/**
 * Tag each span with the server faults its requests hit: an event whose
 * trace id is one of the span's `traceIds` belongs to that span.
 */
export function tagServerFaults(
  spans: ReadonlyArray<{ span: PerfSpanReport; traceIds: readonly string[] | undefined }>,
  events: readonly ServerFaultEvent[],
): void {
  const byTrace = new Map<string, string[]>();
  for (const e of events) {
    if (e.traceId === undefined) continue;
    (byTrace.get(e.traceId) ?? byTrace.set(e.traceId, []).get(e.traceId)!).push(serverFaultName(e));
  }
  if (byTrace.size === 0) return;
  for (const { span, traceIds } of spans) {
    const names = (traceIds ?? []).flatMap((id) => byTrace.get(id) ?? []);
    if (names.length > 0) addSpanFaults(span, names);
  }
}

/** How many `(key, fault)` pairs the degradation report keeps. */
export const DEGRADATION_TOP_N = 10;

const round1 = (n: number) => Math.round(n * 10) / 10;

function side(spans: readonly PerfSpanReport[]): PerfDegradationSide {
  const interactions = spans.flatMap((s) => (s.interaction ? [s.interaction.maxDurationMs] : []));
  return {
    n: spans.length,
    durationMs: median(spans.map((s) => s.durationMs)),
    blockingMs: median(spans.map((s) => s.cpu.blockingMs)),
    requestCount: median(spans.map((s) => s.network.requestCount)),
    ...(interactions.length > 0 ? { interactionMs: median(interactions) } : {}),
  };
}

/**
 * For every perfKey and every fault seen on its spans: the median span with
 * the fault against the median span without it. A pair appears only when
 * both sides have a span — a fault that hit every span of a key (a runtime
 * fault is on every page) has nothing to compare with. Medians rather than
 * means, so one outlier on either side does not make the delta.
 *
 * Sorted by the `durationMs` delta, largest first; ties keep the order the
 * keys were first seen. Negative deltas stay in: a fault that made a step
 * faster (a 503 skipping the render) is a finding too, it just sorts last.
 */
export function buildDegradation(
  spans: readonly PerfSpanReport[],
  topN = DEGRADATION_TOP_N,
): PerfDegradationEntry[] {
  const byKey = new Map<string, PerfSpanReport[]>();
  for (const s of spans) (byKey.get(s.key) ?? byKey.set(s.key, []).get(s.key)!).push(s);

  const entries: PerfDegradationEntry[] = [];
  for (const [key, group] of byKey) {
    const faults = new Set(group.flatMap((s) => s.faults ?? []));
    for (const fault of [...faults].sort()) {
      const hit = group.filter((s) => s.faults?.includes(fault));
      const miss = group.filter((s) => !s.faults?.includes(fault));
      if (hit.length === 0 || miss.length === 0) continue;
      const faulted = side(hit);
      const clean = side(miss);
      entries.push({
        key,
        fault,
        faulted,
        clean,
        delta: {
          durationMs: round1(faulted.durationMs - clean.durationMs),
          blockingMs: round1(faulted.blockingMs - clean.blockingMs),
          requestCount: round1(faulted.requestCount - clean.requestCount),
          ...(faulted.interactionMs !== undefined && clean.interactionMs !== undefined
            ? { interactionMs: round1(faulted.interactionMs - clean.interactionMs) }
            : {}),
        },
      });
    }
  }
  // Array.prototype.sort is stable, so equal deltas keep first-seen order.
  return entries.sort((a, b) => b.delta.durationMs - a.delta.durationMs).slice(0, topN);
}
