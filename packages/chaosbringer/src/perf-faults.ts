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
import { round1 } from "./perf-math.js";
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

/**
 * How long until a span's own work finished: its wall time, or — when it
 * fired requests it did not wait for — until the last of them finished.
 * Under the `networkidle` settle a click that fires a fetch closes a few ms
 * after the fetch starts; a delay fault on that fetch then lands in
 * `network.settledMs`, never in `durationMs`.
 */
export function effectiveDurationMs(span: Pick<PerfSpanReport, "durationMs" | "network">): number {
  return Math.max(span.durationMs, span.network.settledMs ?? 0);
}

function side(spans: readonly PerfSpanReport[]): PerfDegradationSide {
  const interactions = spans.flatMap((s) => (s.interaction ? [s.interaction.maxDurationMs] : []));
  return {
    n: spans.length,
    durationMs: median(spans.map((s) => s.durationMs)),
    effectiveMs: median(spans.map(effectiveDurationMs)),
    blockingMs: median(spans.map((s) => s.cpu.blockingMs)),
    requestCount: median(spans.map((s) => s.network.requestCount)),
    ...(interactions.length > 0 ? { interactionMs: median(interactions) } : {}),
  };
}

/**
 * For every perfKey and every fault seen on its spans: the median span with
 * the fault against the median clean span. A pair appears only when both
 * sides have a span — a fault that hit every span of a key (a runtime fault
 * is on every page) has nothing to compare with. Medians rather than means,
 * so one outlier on either side does not make the delta.
 *
 * "Clean" is a span with none of the key's faults, not merely without this
 * one: a span carrying another fault has that fault's cost in it. When a key
 * had loads hit by server latency and one by a 503 and none by neither, the
 * 503's "clean" side was the latency-faulted loads and the entry read as
 * "a 503 makes the load 300 ms faster". The faults on *every* span of the key
 * (runtime faults, a lifecycle fault fired before the load) are the key's
 * baseline rather than a difference, so they do not disqualify a span; without
 * that, any runtime fault would leave no clean span at all. The faulted side
 * stays "every span with this fault", other faults included, so faults that
 * always fire together still get a row.
 *
 * Each side also carries `effectiveMs` (`effectiveDurationMs`): a step's
 * wall time stretched to when the requests it started finished. That is the
 * number a delay fault on a fetch the step did not wait for shows up in —
 * under `networkidle` a click's `durationMs` delta for it reads ~0 (or
 * slightly negative, noise) while its `effectiveMs` delta reads the delay.
 * `durationMs` stays as the span measured it.
 *
 * Sorted by the `effectiveMs` delta, largest first; ties keep the order the
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
    const everywhere = new Set([...faults].filter((f) => group.every((s) => s.faults?.includes(f))));
    const clean = group.filter((s) => (s.faults ?? []).every((f) => everywhere.has(f)));
    for (const fault of [...faults].sort()) {
      // On every span: nothing to compare with (and `clean` would be the hit spans).
      if (everywhere.has(fault)) continue;
      const hit = group.filter((s) => s.faults?.includes(fault));
      if (hit.length === 0 || clean.length === 0) continue;
      const faulted = side(hit);
      const base = side(clean);
      entries.push({
        key,
        fault,
        faulted,
        clean: base,
        delta: {
          durationMs: round1(faulted.durationMs - base.durationMs),
          effectiveMs: round1(faulted.effectiveMs - base.effectiveMs),
          blockingMs: round1(faulted.blockingMs - base.blockingMs),
          requestCount: round1(faulted.requestCount - base.requestCount),
          ...(faulted.interactionMs !== undefined && base.interactionMs !== undefined
            ? { interactionMs: round1(faulted.interactionMs - base.interactionMs) }
            : {}),
        },
      });
    }
  }
  // Array.prototype.sort is stable, so equal deltas keep first-seen order.
  return entries.sort((a, b) => b.delta.effectiveMs - a.delta.effectiveMs).slice(0, topN);
}
