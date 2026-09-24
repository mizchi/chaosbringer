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
  longTasks: LongTaskEntry[];
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

  const store: PerfStore = {
    __lb: true,
    vitals: {},
    longTasks: [],
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
  const drainLongTask = (entries: PerformanceEntryList) => {
    for (const e of entries)
      store.longTasks.push({ start: e.startTime, duration: e.duration });
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

  const observers: PerformanceObserver[] = [];
  const observe = (
    drain: (e: PerformanceEntryList) => void,
    init: PerformanceObserverInit,
  ) => {
    try {
      const obs = new PerformanceObserver((list) => drain(list.getEntries()));
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
  addEventListener("pagehide", emit, { capture: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") emit();
    },
    { capture: true },
  );
}
