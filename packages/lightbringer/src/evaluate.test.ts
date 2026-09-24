import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPSession, Page } from "playwright";
import { BoundedEvaluator } from "./evaluate";
import { PerfController } from "./controller";

// A page whose evaluate never settles until released — what Playwright does
// while a navigation's document request goes unanswered.
function hungPage() {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const page = {
    isClosed: () => false,
    evaluate: (fn: () => unknown) => {
      calls += 1;
      return gate.then(() => fn());
    },
    waitForLoadState: async () => {},
  } as unknown as Page;
  return { page, release: () => release(undefined), calls: () => calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BoundedEvaluator", () => {
  it("returns the value of an evaluate that answers", async () => {
    const page = { evaluate: async (fn: () => unknown) => fn() } as unknown as Page;
    const ev = new BoundedEvaluator(page, 50);
    expect(await ev.attempt(() => 42)).toEqual({ kind: "ok", value: 42 });
  });

  it("reports a rejected evaluate as an error, never throwing", async () => {
    const page = {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
    } as unknown as Page;
    const r = await new BoundedEvaluator(page, 50).attempt(() => 1);
    expect(r.kind).toBe("error");
  });

  it("times out a hung evaluate and uses the fallback", async () => {
    const { page } = hungPage();
    const ev = new BoundedEvaluator(page, 30);
    const t0 = Date.now();
    expect(await ev.evaluate(() => "live", () => "fallback")).toBe("fallback");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("short-circuits later reads while the timed-out one is pending, then recovers", async () => {
    const h = hungPage();
    const ev = new BoundedEvaluator(h.page, 30);
    expect((await ev.attempt(() => 1)).kind).toBe("timeout");
    // Returns at once without issuing another evaluate.
    expect((await ev.attempt(() => 2)).kind).toBe("timeout");
    expect(h.calls()).toBe(1);
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await ev.attempt(() => 3)).toEqual({ kind: "ok", value: 3 });
  });
});

describe("PerfController on a hung page", () => {
  it("begin/end/drain return within the evaluate bound, recording the span", async () => {
    const { page } = hungPage();
    let ts = 1;
    const client = {
      send: async (method: string) =>
        method === "Performance.getMetrics"
          ? { metrics: [{ name: "Timestamp", value: ts++ }] }
          : {},
    } as unknown as CDPSession;
    const controller = new PerfController(page, client, { evaluateTimeoutMs: 40 });
    const t0 = Date.now();
    const h = await controller.begin("hung");
    await controller.end(h, { settle: false });
    await controller.drain();
    // One bounded wait in total: the stalled read short-circuits the rest.
    expect(Date.now() - t0).toBeLessThan(500);
    expect(controller.spans.map((s) => s.name)).toEqual(["hung"]);
  });
});
