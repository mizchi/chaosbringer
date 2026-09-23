// ---------------------------------------------------------------------------
// Browser-side collector (injected at document-start via addInitScript).
// Stringified and run inside the page, so it must be fully self-contained — no
// imports may appear inside browserCollector's body. long task / LoAF are stored
// in performance.now() time and shifted to epoch ms at aggregation using
// timeOrigin.
// ---------------------------------------------------------------------------

export interface BrowserMetric {
  name: string;
  value: number;
  rating: string;
  attribution?: Record<string, unknown>;
}

export interface PerfWindow {
  webVitals?: {
    onLCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onCLS: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onINP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onTTFB: (cb: (m: BrowserMetric) => void, opts?: object) => void;
    onFCP: (cb: (m: BrowserMetric) => void, opts?: object) => void;
  };
  __perf?: {
    vitals: Record<string, BrowserMetric>;
    longTasks: Array<{ start: number; duration: number }>;
    loaf: Array<{ start: number; duration: number; blocking: number }>;
    measures: Array<{
      name: string;
      start: number;
      duration: number;
      detail: unknown;
    }>;
    /** Event Timing entries for real interactions (interactionId > 0) */
    events: Array<{
      start: number;
      duration: number;
      type: string;
      processingStart: number;
      processingEnd: number;
    }>;
    /** requestAnimationFrame timestamps (DOMHighResTimeStamp) — frame cadence */
    frames: number[];
    /** drain pending PerformanceObserver records into the store (see flush below) */
    flush?: () => void;
  };
}

export function browserCollector() {
  const w = window as unknown as PerfWindow;
  w.__perf = { vitals: {}, longTasks: [], loaf: [], measures: [], events: [], frames: [] };
  const store = w.__perf;

  // Record frame cadence with a self-rescheduling rAF. Each callback just pushes
  // a timestamp (negligible work), so the gap between frames reflects the page's
  // own jank, not the probe. A gap >> 16.7ms means dropped frames.
  const onFrame = (t: number) => {
    store.frames.push(t);
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

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
}
