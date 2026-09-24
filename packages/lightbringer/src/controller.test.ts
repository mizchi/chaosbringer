import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPSession, Page } from "playwright";
import { PerfController } from "./controller";
import type { PerfStore } from "./browser";

// PerfController only talks to the page through evaluate / isClosed /
// waitForLoadState and to CDP through send, so a fake of each is enough to
// pin the span bookkeeping. evaluate runs the page function against a stubbed
// `window` whose __perf is a hand-built store.

function fakeStore(): PerfStore & { startFramesCalls: number } {
  const store = {
    __lb: true as const,
    vitals: {},
    longTasks: [],
    loaf: [],
    measures: [],
    events: [],
    frames: [],
    startFramesCalls: 0,
    startFrames() {
      store.startFramesCalls += 1;
    },
    now: () => Date.now(),
    drain: () => ({
      timeOrigin: 1_000,
      url: "http://x.test/",
      vitals: {},
      longTasks: [],
      loaf: [],
      measures: [],
      events: [],
      frames: [],
    }),
  };
  return store;
}

function fakes() {
  const store = fakeStore();
  vi.stubGlobal("window", { __perf: store });
  const page = {
    isClosed: () => false,
    evaluate: async (fn: () => unknown) => fn(),
    waitForLoadState: async () => {},
  } as unknown as Page;
  let ts = 1;
  const client = {
    send: async (method: string) => {
      if (method === "Performance.getMetrics")
        return { metrics: [{ name: "Timestamp", value: ts++ }] };
      return {};
    },
  } as unknown as CDPSession;
  return { store, controller: new PerfController(page, client) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PerfController.begin", () => {
  it("starts the collector's frame probe", async () => {
    const { store, controller } = fakes();
    await controller.begin("a");
    expect(store.startFramesCalls).toBe(1);
  });

  it("tolerates a document without a collector", async () => {
    const { controller } = fakes();
    vi.stubGlobal("window", {});
    const h = await controller.begin("a");
    await controller.end(h, { settle: false });
    expect(controller.spans).toHaveLength(1);
  });
});

describe("PerfController.cancel", () => {
  it("discards a begun span without recording it", async () => {
    const { controller } = fakes();
    const h = await controller.begin("skipped");
    controller.cancel(h);
    await controller.end(h, { settle: false });
    expect(controller.spans).toHaveLength(0);
  });

  it("is a no-op for an ended, cancelled or unknown handle", async () => {
    const { controller } = fakes();
    const h = await controller.begin("kept");
    await controller.end(h, { settle: false });
    controller.cancel(h);
    controller.cancel(h);
    controller.cancel({ id: 999, name: "ghost", startEpochMs: 0 });
    await controller.end({ id: 999, name: "ghost", startEpochMs: 0 }, { settle: false });
    await controller.end(h, { settle: false });
    expect(controller.spans.map((s) => s.name)).toEqual(["kept"]);
  });

  it("leaves other open spans intact", async () => {
    const { controller } = fakes();
    const outer = await controller.begin("outer");
    const inner = await controller.begin("inner");
    controller.cancel(inner);
    await controller.end(outer, { settle: false });
    expect(controller.spans.map((s) => s.name)).toEqual(["outer"]);
  });
});
