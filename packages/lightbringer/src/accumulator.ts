// ---------------------------------------------------------------------------
// Node-side accumulation of drained in-page entries. Pure (no Playwright): each
// DrainPayload is shifted to epoch ms with ITS OWN document's timeOrigin at merge
// time, so once merged, document identity no longer matters for time — spans are
// matched purely by epoch window. Web-vitals are kept per document.
// ---------------------------------------------------------------------------
import type { BrowserMetric, DrainPayload, PerfStore } from "./browser";
import type { EpochEvent } from "./analyze/vitals";

export interface EpochLongTask {
  epochStart: number;
  duration: number;
}
export interface EpochLoaf {
  epochStart: number;
  duration: number;
  blocking: number;
}
/** A User Timing measure with startTime already in epoch ms. */
export interface EpochMeasure {
  name: string;
  startTime: number;
  duration: number;
  detail: unknown;
}
/** The latest web-vitals of one document (keyed by its timeOrigin). */
export interface DocumentVitalsRaw {
  url: string;
  timeOrigin: number;
  vitals: Record<string, BrowserMetric>;
}

/** Read-only view buildReport consumes. */
export interface AccumulatedEntries {
  longTasks: EpochLongTask[];
  loaf: EpochLoaf[];
  events: EpochEvent[];
  frames: number[];
  measures: EpochMeasure[];
  /** one entry per document, ordered by timeOrigin (navigation order) */
  documents: DocumentVitalsRaw[];
}

export interface AccumulatorOptions {
  /**
   * Frames with an epoch before this are dropped on merge (frame cadence only
   * matters inside spans). Called on every merge; return -Infinity to keep all,
   * +Infinity to keep none. Default: keep all.
   */
  keepFramesFrom?: () => number;
}

export class PerfAccumulator implements AccumulatedEntries {
  readonly longTasks: EpochLongTask[] = [];
  readonly loaf: EpochLoaf[] = [];
  readonly events: EpochEvent[] = [];
  frames: number[] = [];
  readonly measures: EpochMeasure[] = [];
  readonly documents: DocumentVitalsRaw[] = [];
  /** true once any document reported a non-native performance.now (see DrainPayload.clockPatched) */
  clockPatched = false;
  private keepFramesFrom: () => number;

  constructor(opts: AccumulatorOptions = {}) {
    this.keepFramesFrom = opts.keepFramesFrom ?? (() => -Infinity);
  }

  /** Replace the frame-retention policy (PerfController installs its own). */
  setKeepFramesFrom(fn: () => number): void {
    this.keepFramesFrom = fn;
  }

  /** true once at least one document delivered a store (the collector ran). */
  get sawDocument(): boolean {
    return this.documents.length > 0;
  }

  /** Merge one drain. Tolerates missing arrays (older / partial payloads). */
  add(p: DrainPayload | null | undefined): void {
    if (!p || typeof p.timeOrigin !== "number") return;
    // The initial about:blank document of a new page (reached by a context-level
    // collectorInitScript) emits on its pagehide at the first goto. With nothing
    // but rAF frames in it, it is not a document the test observed.
    if (p.url === "about:blank" && isEmptyPayload(p)) return;
    if (p.clockPatched) this.clockPatched = true;
    const to = p.timeOrigin;
    for (const t of p.longTasks ?? [])
      this.longTasks.push({ epochStart: to + t.start, duration: t.duration });
    for (const l of p.loaf ?? [])
      this.loaf.push({ epochStart: to + l.start, duration: l.duration, blocking: l.blocking });
    for (const e of p.events ?? [])
      this.events.push({
        epochStart: to + e.start,
        duration: e.duration,
        type: e.type,
        start: e.start,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
      });
    for (const m of p.measures ?? [])
      this.measures.push({
        name: m.name,
        startTime: to + m.start,
        duration: m.duration,
        detail: m.detail,
      });
    const from = this.keepFramesFrom();
    for (const f of p.frames ?? []) {
      const epoch = to + f;
      if (epoch >= from) this.frames.push(epoch);
    }
    let doc = this.documents.find((d) => d.timeOrigin === to);
    if (!doc) {
      doc = { url: p.url, timeOrigin: to, vitals: {} };
      // Keep navigation order even when an unloading document's pagehide emit
      // arrives after its successor's first drain.
      const at = this.documents.findIndex((d) => d.timeOrigin > to);
      if (at < 0) this.documents.push(doc);
      else this.documents.splice(at, 0, doc);
    }
    if (p.url) doc.url = p.url;
    Object.assign(doc.vitals, p.vitals ?? {});
  }

  /** Drop stored frames after `epoch` (the idle gap after the last closed span). */
  dropFramesAfter(epoch: number): void {
    this.frames = this.frames.filter((t) => t <= epoch);
  }

  /** The latest document by timeOrigin (the one the report's top-level `vitals` describe). */
  lastDocument(): DocumentVitalsRaw | undefined {
    return this.documents[this.documents.length - 1];
  }
}

function isEmptyPayload(p: DrainPayload): boolean {
  return (
    Object.keys(p.vitals ?? {}).length === 0 &&
    !p.longTasks?.length &&
    !p.loaf?.length &&
    !p.measures?.length &&
    !p.events?.length
  );
}

/**
 * Build accumulated entries from a single-document store snapshot (the pre-drain
 * `window.__perf` shape) — lets buildReport keep accepting the old arguments.
 */
export function accumulateSnapshot(
  raw: Pick<PerfStore, "vitals" | "longTasks" | "loaf" | "measures"> &
    Partial<Pick<PerfStore, "events" | "frames">>,
  timeOrigin: number,
  url = "",
): PerfAccumulator {
  const acc = new PerfAccumulator();
  acc.add({
    timeOrigin,
    url,
    vitals: raw.vitals,
    longTasks: raw.longTasks,
    loaf: raw.loaf,
    measures: raw.measures,
    events: raw.events ?? [],
    frames: raw.frames ?? [],
  });
  return acc;
}
