import { afterEach, describe, expect, it, vi } from "vitest";
import { browserCollector, type PerfWindow } from "./browser";
import { collectorInitScript } from "./session";

// browserCollector runs in the page, but it only touches a handful of globals.
// Stubbing them lets the frame-probe switch be checked without a browser; the
// full collector is exercised against Chromium in examples/*.spec.ts.
function installGlobals() {
  const win: PerfWindow & Record<string, unknown> = {};
  win.top = win;
  const rafCallbacks: Array<(t: number) => void> = [];
  vi.stubGlobal("window", win);
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      observe() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal("location", { href: "http://x.test/" });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  return { win, rafCallbacks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserCollector frame probe", () => {
  it("starts the rAF probe at install by default", () => {
    const { rafCallbacks } = installGlobals();
    browserCollector();
    expect(rafCallbacks).toHaveLength(1);
  });

  it("frames: false defers the probe to startFrames(), which is idempotent", () => {
    const { win, rafCallbacks } = installGlobals();
    browserCollector({ frames: false });
    expect(rafCallbacks).toHaveLength(0);
    win.__perf?.startFrames?.();
    win.__perf?.startFrames?.();
    expect(rafCallbacks).toHaveLength(1);
    // The probe reschedules itself and records the timestamp.
    rafCallbacks[0](16);
    expect(win.__perf?.frames).toEqual([16]);
    expect(rafCallbacks).toHaveLength(2);
  });

  it("startFrames() on a default collector does not add a second probe", () => {
    const { win, rafCallbacks } = installGlobals();
    browserCollector();
    win.__perf?.startFrames?.();
    expect(rafCallbacks).toHaveLength(1);
  });
});

type Entry = { entryType: string; startTime: number; duration: number };
type Payload = { longTasks: Array<{ start: number; duration: number }> };

// A PerformanceObserver stub on top of installGlobals(): a test delivers
// entries to one entry type's observer as the browser's callback would, or
// queues them for that observer's takeRecords(), which flush() reads.
function installObservers(emit?: (payload: string) => void) {
  const { win } = installGlobals();
  const observers = new Map<string, { cb: (list: { getEntries: () => Entry[] }) => void; queued: Entry[] }>();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      cb: (list: { getEntries: () => Entry[] }) => void;
      queued: Entry[] = [];
      constructor(cb: (list: { getEntries: () => Entry[] }) => void) {
        this.cb = cb;
      }
      observe(init: { type: string }) {
        observers.set(init.type, this);
      }
      takeRecords() {
        return this.queued.splice(0);
      }
    },
  );
  if (emit) win.__lbEmit = emit;
  const deliver = (type: string, entry: Entry) => observers.get(type)?.cb({ getEntries: () => [entry] });
  const longTask = (startTime: number, duration: number) =>
    deliver("longtask", { entryType: "longtask", startTime, duration });
  const queueLongTask = (startTime: number, duration: number) =>
    observers.get("longtask")?.queued.push({ entryType: "longtask", startTime, duration });
  const loaf = (startTime: number, duration: number) =>
    deliver("long-animation-frame", { entryType: "long-animation-frame", startTime, duration });
  return { win, longTask, queueLongTask, loaf };
}

describe("browserCollector longTaskLog / lastLongTaskEnd", () => {
  it("keeps every long task in-page while the emit binding moves each to node once", () => {
    const sent: Payload[] = [];
    const { win, longTask } = installObservers((p) => sent.push(JSON.parse(p)));
    browserCollector({ frames: false });
    const store = win.__perf!;
    longTask(100, 200);
    expect(store.longTasks).toEqual([]);
    longTask(400, 70);
    // The binding emptied `longTasks` at each callback…
    expect(store.longTasks).toEqual([]);
    expect(sent.flatMap((p) => p.longTasks)).toEqual([
      { start: 100, duration: 200 },
      { start: 400, duration: 70 },
    ]);
    // …and the log and the last end still have them.
    expect(store.longTaskLog).toEqual([
      { start: 100, duration: 200 },
      { start: 400, duration: 70 },
    ]);
    expect(store.lastLongTaskEnd).toBe(470);
    // A later drain delivers nothing twice, and resets neither.
    expect(store.drain!().longTasks).toEqual([]);
    expect(store.longTaskLog).toHaveLength(2);
    expect(store.lastLongTaskEnd).toBe(470);
  });

  it("without the binding, longTasks and the log hold the same entry", () => {
    const { win, longTask } = installObservers();
    browserCollector({ frames: false });
    const store = win.__perf!;
    expect(store.lastLongTaskEnd).toBeNull();
    longTask(100, 200);
    expect(store.lastLongTaskEnd).toBe(300);
    expect(store.longTasks).toHaveLength(1);
    expect(store.longTaskLog![0]).toBe(store.longTasks[0]);
  });

  it("a record flush() takes counts at once and still reaches node exactly once", () => {
    const sent: Payload[] = [];
    const { win, longTask, queueLongTask } = installObservers((p) => sent.push(JSON.parse(p)));
    browserCollector({ frames: false });
    const store = win.__perf!;
    queueLongTask(100, 80);
    store.flush!();
    expect(store.longTasks).toEqual([{ start: 100, duration: 80 }]);
    expect(store.longTaskLog).toEqual([{ start: 100, duration: 80 }]);
    expect(store.lastLongTaskEnd).toBe(180);
    // flush() only moves records into the store: nothing was emitted.
    expect(sent).toEqual([]);
    longTask(300, 60);
    expect(sent.flatMap((p) => p.longTasks)).toEqual([
      { start: 100, duration: 80 },
      { start: 300, duration: 60 },
    ]);
    expect(store.lastLongTaskEnd).toBe(360);
  });

  it("another entry type's emit empties longTasks, not the log", () => {
    const sent: Payload[] = [];
    const { win, longTask, loaf } = installObservers((p) => sent.push(JSON.parse(p)));
    browserCollector({ frames: false });
    const store = win.__perf!;
    // Emitted at once with the binding; leave one in `longTasks` by delivering
    // it while the binding is away, as on a page whose session has not begun.
    delete win.__lbEmit;
    longTask(100, 200);
    expect(store.longTasks).toHaveLength(1);
    win.__lbEmit = (p) => sent.push(JSON.parse(p));
    loaf(400, 90);
    expect(store.longTasks).toEqual([]);
    expect(sent.flatMap((p) => p.longTasks)).toEqual([{ start: 100, duration: 200 }]);
    expect(store.longTaskLog).toEqual([{ start: 100, duration: 200 }]);
    expect(store.lastLongTaskEnd).toBe(300);
  });

  it("drops the oldest entry past 10000; the last end stays exact", () => {
    const { win, longTask } = installObservers(() => {});
    browserCollector({ frames: false });
    for (let i = 0; i < 10_001; i++) longTask(i * 60, 51);
    const log = win.__perf!.longTaskLog!;
    expect(log).toHaveLength(10_000);
    expect(log[0].start).toBe(60);
    expect(log[log.length - 1].start).toBe(10_000 * 60);
    expect(win.__perf!.lastLongTaskEnd).toBe(10_000 * 60 + 51);
  });

  it("the last end is the latest end, not the latest observed", () => {
    const { win, longTask } = installObservers();
    browserCollector({ frames: false });
    longTask(100, 400);
    longTask(200, 60);
    expect(win.__perf!.lastLongTaskEnd).toBe(500);
  });
});

describe("browserCollector detach / attach", () => {
  it("a detached store keeps its records for the next drain instead of emitting them", () => {
    const sent: Payload[] = [];
    const { win, longTask } = installObservers((p) => sent.push(JSON.parse(p)));
    browserCollector({ frames: false });
    const store = win.__perf!;
    longTask(100, 200);
    expect(sent).toHaveLength(1);
    store.detach!();
    longTask(400, 70);
    // The binding function is still there (removeBinding cannot take it away),
    // but nothing went through it and nothing was moved out.
    expect(sent).toHaveLength(1);
    expect(store.longTasks).toEqual([{ start: 400, duration: 70 }]);
    store.attach!();
    longTask(600, 80);
    expect(sent).toHaveLength(2);
    expect(sent[1].longTasks).toEqual([
      { start: 400, duration: 70 },
      { start: 600, duration: 80 },
    ]);
  });

  it("detach stops the frame probe; startFrames restarts it", () => {
    const { win, rafCallbacks } = installGlobals();
    vi.stubGlobal("cancelAnimationFrame", () => {});
    browserCollector();
    const store = win.__perf!;
    rafCallbacks[0](16);
    store.detach!();
    // The callback already scheduled sees the probe stopped and records nothing.
    rafCallbacks[1](32);
    expect(store.frames).toEqual([16]);
    expect(rafCallbacks).toHaveLength(2);
    store.startFrames!();
    expect(rafCallbacks).toHaveLength(3);
    rafCallbacks[2](48);
    expect(store.frames).toEqual([16, 48]);
  });

  it("bounds the buffers nothing drains", () => {
    const { win, rafCallbacks } = installGlobals();
    browserCollector();
    for (let i = 0; i < 36_005; i++) rafCallbacks[i](i);
    expect(win.__perf!.frames).toHaveLength(36_000);
    expect(win.__perf!.frames[0]).toBe(5);
  });

  it("bounds an undrained long-task buffer to the latest 10000", () => {
    const { win, longTask } = installObservers();
    browserCollector({ frames: false });
    for (let i = 0; i < 10_003; i++) longTask(i * 100, 60);
    expect(win.__perf!.longTasks).toHaveLength(10_000);
    expect(win.__perf!.longTasks[0]).toEqual({ start: 300, duration: 60 });
  });
});

describe("collectorInitScript", () => {
  it("caches one script per frames setting", () => {
    expect(collectorInitScript()).toBe(collectorInitScript({ frames: true }));
    expect(collectorInitScript({ frames: false })).toBe(collectorInitScript({ frames: false }));
    expect(collectorInitScript({ frames: false })).not.toBe(collectorInitScript());
  });

  it("passes frames: false into the page", () => {
    expect(collectorInitScript({ frames: false })).toMatch(/\)\(\{"frames":false\}\);\n$/);
    expect(collectorInitScript()).toMatch(/\)\(\);\n$/);
  });
});
