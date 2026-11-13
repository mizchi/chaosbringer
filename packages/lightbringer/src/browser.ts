// ---------------------------------------------------------------------------
// Browser-side collector (injected at document-start via addInitScript).
// Stringified and run inside the page, so it must be fully self-contained — no
// imports may appear inside browserCollector's body.
//
// Entries are buffered in performance.now() time. The node side DRAINS them
// (moves them out, together with this document's timeOrigin) at every span
// boundary and converts them to epoch ms, so a navigation — which recreates the
// store — no longer loses the earlier documents' data. The remainder of an
// unloading document is pushed to node on pagehide / visibilitychange→hidden
// through the `__lbEmit` CDP binding (Runtime.addBinding), when installed.
// Long tasks are also kept in a never-drained per-document log for in-page
// readers (PerfStore.longTaskLog / lastLongTaskEnd).
// ---------------------------------------------------------------------------

export interface BrowserMetric {
  name: string;
  value: number;
  rating: string;
  attribution?: Record<string, unknown>;
}

export interface LongTaskEntry {
  start: number;
  duration: number;
}
export interface LoafEntry {
  start: number;
  duration: number;
  blocking: number;
}
export interface MeasureEntry {
  name: string;
  start: number;
  duration: number;
  detail: unknown;
}
export interface EventEntry {
  start: number;
  duration: number;
  type: string;
  processingStart: number;
  processingEnd: number;
}

/**
 * What one drain() returns: everything buffered since the previous drain, in
 * this document's performance.now() time, plus the document's identity. Entries
 * are MOVED out of the store, so no entry is ever delivered twice. `vitals` is
 * the document's latest value per metric (last-write-wins; not cleared).
 */
export interface DrainPayload {
  timeOrigin: number;
  url: string;
  vitals: Record<string, BrowserMetric>;
  longTasks: LongTaskEntry[];
  loaf: LoafEntry[];
  measures: MeasureEntry[];
  events: EventEntry[];
  frames: number[];
  /**
   * true when performance.now was already replaced by page JS (not native) when
   * the collector was installed — e.g. a clock-skew init script ran first — so
   * span epochs of this document are on the patched clock.
   */
  clockPatched?: boolean;
}

export interface PerfStore {
  /** idempotency marker: set by this collector, so a second injection is a no-op */
  __lb?: true;
  vitals: Record<string, BrowserMetric>;
  /**
   * Long tasks observed since the previous drain(), which moves them out. In
   * the top document of a page with a session's emit binding, that happens at
   * every observer callback, so this is almost always empty there: in-page
   * code reads `longTaskLog` / `lastLongTaskEnd` instead.
   */
  longTasks: LongTaskEntry[];
  /**
   * This document's long tasks in the order they were observed (by the
   * observer callback and by flush() alike): the same entry objects as
   * `longTasks`, which drain() never moves. For in-page readers, such as
   * chaosbringer's TBT read. Bounded: past 10000 entries the oldest is
   * dropped. Main-thread long tasks each last over 50 ms and do not overlap,
   * so back-to-back 51 ms tasks report about 18 a second: the cap is about
   * 9 minutes of nothing but long tasks, at about 48 bytes an entry. A page
   * load's read is bounded by its navigation timeout, about 550 entries at
   * 30 s. Absent on collectors older than this field.
   */
  longTaskLog?: LongTaskEntry[];
  /**
   * start + duration (this document's timeline) of the latest-ending long
   * task observed, null before the first. drain() never resets it, and it
   * does not depend on `longTaskLog`'s cap: a settle probe's long-task gate
   * reads it in O(1). Absent on collectors older than this field.
   */
  lastLongTaskEnd?: number | null;
  loaf: LoafEntry[];
  measures: MeasureEntry[];
  /** Event Timing entries for real interactions (interactionId > 0) */
  events: EventEntry[];
  /** requestAnimationFrame timestamps (DOMHighResTimeStamp) — frame cadence */
  frames: number[];
  /** drain pending PerformanceObserver records into the store (see flush below) */
  flush?: () => void;
  /** flush, then move every buffered entry out (see DrainPayload) */
  drain?: () => DrainPayload;
  /**
   * Start the rAF frame probe if it is not running yet (idempotent). The
   * collector starts it itself unless it was installed with `frames: false`;
   * PerfController.begin() calls this so a span always gets frame cadence.
   */
  startFrames?: () => void;
  /**
   * Epoch ms from the performance.now / timeOrigin captured when the collector
   * was installed — immune to later monkey-patching of performance.now / Date
   * (e.g. chaosbringer's clock-skew runtime fault).
   */
  now?: () => number;
}

export interface PerfWindow {
  webVitals?: {
    onLCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onCLS: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onINP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onTTFB: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onFCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
  };
  __perf?: PerfStore;
  /** CDP binding installed by startSession (Runtime.addBinding) */
  __lbEmit?: (payload: string) => void;
}

export interface CollectorOptions {
  /**
   * Start the rAF frame probe at install (default true). false installs the
   * observers only; the probe then starts on the first store.startFrames(),
   * so an always-on collector adds no per-frame callback to pages nobody
   * measures.
   */
  frames?: boolean;
}

export function browserCollector(opts?: CollectorOptions) {
  const w = window as unknown as PerfWindow;
  // Idempotent: a second injection into the same document (e.g. context-level
  // collectorInitScript() plus a page-level one) must not double-register.
  if (w.__perf && w.__perf.__lb) return;

  // Capture the native clock before any later init script can patch it.
  const timeOrigin = performance.timeOrigin;
  const perfNow = performance.now.bind(performance);
  let clockPatched = false;
  try {
    clockPatched = !/\[native code\]/.test(
      Function.prototype.toString.call(performance.now),
    );
  } catch {
    /* toString unavailable: assume native */
  }

  // Inside the function, not at module scope: it is serialized into the page.
  const LONG_TASK_LOG_MAX = 10000;
  const longTaskLog: LongTaskEntry[] = [];
  const store: PerfStore = {
    __lb: true,
    vitals: {},
    longTasks: [],
    longTaskLog,
    lastLongTaskEnd: null,
    loaf: [],
    measures: [],
    events: [],
    frames: [],
  };
  w.__perf = store;
  store.now = () => timeOrigin + perfNow();

  // Record frame cadence with a self-rescheduling rAF. Each callback just pushes
  // a timestamp (negligible work), so the gap between frames reflects the page's
  // own jank, not the probe. A gap >> 16.7ms means dropped frames. The buffer is
  // bounded by drain(), which moves the frames out at every span boundary.
  const onFrame = (t: number) => {
    store.frames.push(t);
    requestAnimationFrame(onFrame);
  };
  let framesStarted = false;
  store.startFrames = () => {
    if (framesStarted) return;
    framesStarted = true;
    requestAnimationFrame(onFrame);
  };
  if (!opts || opts.frames !== false) store.startFrames();

  const record = (m: BrowserMetric) => {
    store.vitals[m.name] = m;
  };
  const wv = w.webVitals;
  if (wv) {
    wv.onLCP(record, { reportAllChanges: true });
    wv.onCLS(record, { reportAllChanges: true });
    wv.onINP(record, { reportAllChanges: true });
    wv.onTTFB(record);
    wv.onFCP(record);
  }

  // Handlers are shared between the observer callback and flush(): PerformanceObserver
  // callbacks fire asynchronously, so a long task at the very end of a span would be
  // missed if we read the store before the callback runs. flush() drains takeRecords()
  // right before the node side reads, fixing per-span attribution retroactively
  // (spans are matched by time window, not by arrival order).
  // A long task also goes to the never-drained log and raises the last end:
  // both paths come through here, so a record a reader's flush() pulls in
  // counts at once, and the next emit or drain still delivers it to node once.
  const drainLongTask = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const task = { start: e.startTime, duration: e.duration };
      store.longTasks.push(task);
      if (longTaskLog.push(task) > LONG_TASK_LOG_MAX) longTaskLog.shift();
      const end = task.start + task.duration;
      const last = store.lastLongTaskEnd;
      if (last === null || last === undefined || end > last) store.lastLongTaskEnd = end;
    }
  };
  const drainLoaf = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const loaf = e as PerformanceEntry & { blockingDuration?: number };
      store.loaf.push({
        start: loaf.startTime,
        duration: loaf.duration,
        blocking: loaf.blockingDuration ?? 0,
      });
    }
  };
  const drainMeasure = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const measure = e as PerformanceEntry & { detail?: unknown };
      const detail = measure.detail;
      // Only our own spans (the __lbSpan sentinel) — skip framework measures
      // (React Mount/Update, etc.). detail is read here because toJSON() omits it.
      if (
        !detail ||
        typeof detail !== "object" ||
        (detail as { __lbSpan?: unknown }).__lbSpan !== true
      ) {
        continue;
      }
      store.measures.push({
        name: measure.name,
        start: measure.startTime,
        duration: measure.duration,
        detail,
      });
    }
  };

  // Event Timing: only interactionId>0 entries are real interactions (click,
  // keydown, pointerup, …). duration is input→next-paint (8ms-bucketed); split
  // into input delay / processing / presentation at aggregation.
  type EventTimingLike = PerformanceEntry & {
    processingStart: number;
    processingEnd: number;
    interactionId?: number;
  };
  const drainEvent = (entries: PerformanceEntryList) => {
    for (const e of entries) {
      const pe = e as EventTimingLike;
      if (!pe.interactionId) continue;
      store.events.push({
        start: pe.startTime,
        duration: pe.duration,
        type: pe.name,
        processingStart: pe.processingStart,
        processingEnd: pe.processingEnd,
      });
    }
  };

  // Set below, in the top-level document with the emit binding: push what an
  // observer just recorded to node right away rather than only at pagehide.
  let onRecorded: (() => void) | undefined;
  const observers: PerformanceObserver[] = [];
  const observe = (
    drain: (e: PerformanceEntryList) => void,
    init: PerformanceObserverInit,
  ) => {
    try {
      const obs = new PerformanceObserver((list) => {
        drain(list.getEntries());
        if (onRecorded) onRecorded();
      });
      obs.observe(init);
      observers.push(obs);
    } catch {
      /* entry type unsupported */
    }
  };

  observe(drainLongTask, { type: "longtask", buffered: true });
  observe(drainLoaf, {
    type: "long-animation-frame",
    buffered: true,
  } as PerformanceObserverInit);
  observe(drainMeasure, { type: "measure", buffered: true });
  observe(drainEvent, {
    type: "event",
    buffered: true,
    durationThreshold: 16,
  } as PerformanceObserverInit);

  store.flush = () => {
    for (const obs of observers) {
      const records = obs.takeRecords();
      if (records.length === 0) continue;
      const type = records[0].entryType;
      if (type === "longtask") drainLongTask(records);
      else if (type === "long-animation-frame") drainLoaf(records);
      else if (type === "measure") drainMeasure(records);
      else if (type === "event" || type === "first-input") drainEvent(records);
    }
  };

  // Keep only JSON-safe primitive attribution fields: that is all the report
  // keeps (pickAttribution), and it makes the payload safe to JSON.stringify
  // (raw attribution holds PerformanceEntry / DOM references).
  const plainVitals = (): Record<string, BrowserMetric> => {
    const out: Record<string, BrowserMetric> = {};
    for (const name of Object.keys(store.vitals)) {
      const m = store.vitals[name];
      const attribution: Record<string, unknown> = {};
      const src = m.attribution;
      if (src && typeof src === "object") {
        for (const k of Object.keys(src)) {
          const v = src[k];
          const t = typeof v;
          if (t === "string" || t === "number" || t === "boolean") attribution[k] = v;
        }
      }
      out[name] = { name: m.name, value: m.value, rating: m.rating, attribution };
    }
    return out;
  };

  store.drain = () => {
    if (store.flush) store.flush();
    return {
      timeOrigin,
      url: location.href,
      vitals: plainVitals(),
      longTasks: store.longTasks.splice(0),
      loaf: store.loaf.splice(0),
      measures: store.measures.splice(0),
      events: store.events.splice(0),
      frames: store.frames.splice(0),
      clockPatched,
    };
  };

  // Deliver the remainder of an unloading document to node synchronously via the
  // CDP binding. Only drain when the binding exists — otherwise the entries would
  // be moved out and lost. visibilitychange→hidden is where web-vitals finalizes
  // its values; its listeners were registered first (in the onXXX calls above),
  // so ours run after them. A double emit is harmless: drain() moves entries and
  // vitals are last-write-wins per document.
  //
  // Only the top-level document emits: page.addInitScript and the binding also
  // reach same-process iframes, whose unload would otherwise push the iframe's
  // own entries (long tasks are reported to every frame of the process) and
  // vitals into the accumulator as if it were a new top-level document. The
  // node-side drain() only evaluates in the main frame, so iframes contribute
  // nothing, as before.
  let isTop = false;
  try {
    isTop = window === window.top;
  } catch {
    /* cross-origin top access: we are not the top */
  }
  if (!isTop) return;
  const emit = () => {
    const send = w.__lbEmit;
    if (typeof send !== "function" || !store.drain) return;
    try {
      send(JSON.stringify(store.drain()));
    } catch {
      /* binding gone mid-teardown */
    }
  };
  // Chromium 153 (Playwright 1.63) does not deliver the binding call an
  // unloading document makes: a long task followed by a navigation reached
  // node as nothing. So a long task, an animation frame, a span measure or an
  // interaction is also pushed as soon as its observer reports it, while the
  // document is alive; pagehide still sends whatever came after. That leaves
  // `longTasks` empty almost all the time, which is why in-page readers read
  // `longTaskLog` / `lastLongTaskEnd`.
  onRecorded = emit;
  addEventListener("pagehide", emit, { capture: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") emit();
    },
    { capture: true },
  );
}
