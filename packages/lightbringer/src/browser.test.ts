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
