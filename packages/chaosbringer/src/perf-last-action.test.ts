import type { SpanReport } from "lightbringer/core";
import { describe, expect, it, vi } from "vitest";
import { PagePerf } from "./perf.js";
import type { ActionResult } from "./types.js";

/**
 * `PagePerf.lastActionPerf()` against a stand-in session: the controller
 * records a span per `end()` unless told to drop the next one (a page that
 * closed mid-span), and `peekSpan` reports each recorded span's blocking
 * time as its index * 100 so the tests can tell which span was read.
 */
function fakePerf() {
  const spans: Array<{ name: string }> = [];
  let dropNext = false;
  let id = 0;
  const peekSpan = vi.fn((i: number): SpanReport | undefined =>
    spans[i]
      ? ({
          name: spans[i]!.name,
          durationMs: 5 + i,
          capped: false,
          network: { requestCount: i, encodedKB: i / 2 },
          cpu: { blockingMs: i * 100, longTaskCount: i, maxLongTaskMs: 0, loafCount: 0, maxLoafBlockingMs: 0 },
        } as unknown as SpanReport)
      : undefined,
  );
  const session = {
    controller: {
      spans,
      cancel() {},
      async begin(name: string) {
        return { name, startEpochMs: 0, id: id++ };
      },
      async end(handle: { name: string }) {
        if (dropNext) {
          dropNext = false;
          return;
        }
        spans.push({ name: handle.name });
      },
    },
    peekSpan,
    finish: async () => ({ report: { spans: [] } }),
  };
  const Ctor = PagePerf as unknown as new (...args: unknown[]) => PagePerf;
  const perf = new Ctor(session, { send: async () => ({}) }, "http://localhost:3000/items/7", { level: "light" }, "slug", []);
  return { perf, peekSpan, drop: () => (dropNext = true) };
}

const click = (selector: string): ActionResult => ({ type: "click", selector, target: selector, success: true, timestamp: 0 });

describe("PagePerf.lastActionPerf", () => {
  it("is undefined before any action — the load is not an action", async () => {
    const { perf } = fakePerf();
    await perf.beginLoad();
    await perf.endLoad();
    expect(perf.lastActionPerf()).toBeUndefined();
  });

  it("reports the last action's span, keyed like the report will key it", async () => {
    const { perf } = fakePerf();
    await perf.beginLoad();
    await perf.endLoad();
    const h = await perf.beginAction();
    await perf.endAction(h, click("#save"));
    expect(perf.lastActionPerf()).toEqual({
      key: "/items/:id :: click #save",
      durationMs: 6,
      cpu: { blockingMs: 100, longTaskCount: 1 },
      network: { requestCount: 1, encodedKB: 0.5 },
    });
  });

  it("builds once per action, however often it is asked", async () => {
    const { perf, peekSpan } = fakePerf();
    const h = await perf.beginAction();
    await perf.endAction(h, click("#a"));
    const first = perf.lastActionPerf();
    expect(perf.lastActionPerf()).toBe(first);
    expect(peekSpan).toHaveBeenCalledTimes(1);
  });

  it("never reports an earlier action's span for one whose span was not recorded", async () => {
    const { perf, drop } = fakePerf();
    const a = await perf.beginAction();
    await perf.endAction(a, click("#a"));
    expect(perf.lastActionPerf()?.key).toBe("/items/:id :: click #a");
    drop();
    const b = await perf.beginAction();
    await perf.endAction(b, click("#b"));
    expect(perf.lastActionPerf()).toBeUndefined();
  });

  it("keeps the previous action across a skipped one (no step was taken)", async () => {
    const { perf } = fakePerf();
    const a = await perf.beginAction();
    await perf.endAction(a, click("#a"));
    const skipped = await perf.beginAction();
    perf.cancelAction(skipped);
    expect(perf.lastActionPerf()?.key).toBe("/items/:id :: click #a");
  });
});
