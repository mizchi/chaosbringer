import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { awaitPendingPaint, lightbringerAwaitPaint, paintWaitRecord, type PaintWaitResult } from "./paint-wait";
import { logSummary } from "./report";
import type { PerfReport } from "./report-types";

// awaitPendingPaint's Node side against a page whose evaluate answers from a
// script: what it issues, when it gives up, and what it reports. The in-page
// predicate itself needs a browser (examples/paint-wait.spec.ts, and
// chaosbringer's paint-wait e2e tests).

type InPage = Awaited<ReturnType<typeof lightbringerAwaitPaint>>;
type Step = InPage | "hang" | "reject";

function check(over: Partial<InPage> = {}): InPage {
  return {
    visible: true,
    collector: true,
    timeOrigin: 1_700_000_000_000,
    fcp: null,
    lcp: null,
    pending: [],
    frames: 0,
    flowing: 0,
    ...over,
  };
}

function scriptedPage(steps: Step[]) {
  const args: Array<Record<string, number>> = [];
  const page = {
    evaluate: (fn: unknown, arg: Record<string, number>) => {
      expect(fn).toBe(lightbringerAwaitPaint);
      args.push(arg);
      const step = steps.shift();
      if (step === undefined) throw new Error("unexpected evaluate");
      if (step === "hang") return new Promise(() => {});
      if (step === "reject") return Promise.reject(new Error("Execution context was destroyed"));
      return Promise.resolve(step);
    },
  } as unknown as Page;
  return { page, args };
}

describe("awaitPendingPaint", () => {
  it("issues one quick check and no wait when nothing is pending", async () => {
    const { page, args } = scriptedPage([check({ fcp: 24, lcp: 24 })]);
    const r = await awaitPendingPaint(page);
    expect(args).toHaveLength(1);
    // The quick check runs no frames.
    expect(args[0]!.maxFrames).toBe(0);
    expect(r).toMatchObject({ outcome: "none", fcp: 24, lcp: 24, collector: true, initial: [], final: [], frames: 0 });
    expect(r.timeOrigin).toBe(1_700_000_000_000);
  });

  it("waits when something is pending and takes FCP / LCP from the wait's own read", async () => {
    const { page, args } = scriptedPage([
      check({ fcp: 24, lcp: 24, pending: ["lcp-image"], lcpImage: { url: "/hero.png", area: 360000, candidateSize: 9000, bpp: 20 } }),
      check({ fcp: 24, lcp: 1044, frames: 3, flowing: 2 }),
    ]);
    const r = await awaitPendingPaint(page);
    expect(args).toHaveLength(2);
    expect(args[1]).toMatchObject({ maxFrames: 5, totalFrames: 8, vitalsFrames: 3 });
    // The page is told the wall time it has left, so a wait the cap abandons
    // stops at its first frame after the stall.
    expect(args[1]!.maxMs).toBeLessThanOrEqual(1000);
    expect(args[1]!.maxMs).toBeGreaterThan(900);
    expect(r).toMatchObject({
      outcome: "reported",
      fcp: 24,
      lcp: 1044,
      frames: 3,
      flowing: 2,
      initial: ["lcp-image"],
      final: [],
      lcpImage: { url: "/hero.png" },
    });
  });

  it("reports frames when the frame budget ran out with the paint still pending", async () => {
    const { page } = scriptedPage([
      check({ pending: ["fcp"], content: "text" }),
      check({ pending: ["fcp"], content: "text", frames: 6, flowing: 5 }),
    ]);
    const r = await awaitPendingPaint(page);
    expect(r).toMatchObject({ outcome: "frames", frames: 6, initial: ["fcp"], final: ["fcp"], content: "text" });
  });

  it("stops at the wall cap, then classifies what is still pending with one more quick read", async () => {
    const { page, args } = scriptedPage([
      check({ pending: ["fcp", "lcp-image"], content: "text" }),
      "hang",
      check({ fcp: 30, pending: ["lcp-image"], lcpImage: { url: "/late.png", area: 1, candidateSize: 0, bpp: 1 } }),
    ]);
    const t0 = performance.now();
    const r = await awaitPendingPaint(page, { maxMs: 60 });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(60 + 250);
    expect(args).toHaveLength(3);
    expect(args[2]!.maxFrames).toBe(0);
    expect(r).toMatchObject({
      outcome: "timeout",
      fcp: 30,
      frames: null,
      initial: ["fcp", "lcp-image"],
      final: ["lcp-image"],
      lcpImage: { url: "/late.png" },
    });
  });

  it("keeps what was pending at the start, and reads nothing, when the classifying read hangs too", async () => {
    const { page } = scriptedPage([check({ fcp: 24, pending: ["lcp-image"] }), "hang", "hang"]);
    const t0 = performance.now();
    const r = await awaitPendingPaint(page, { maxMs: 40 });
    expect(performance.now() - t0).toBeLessThan(40 + 250 + 100);
    expect(r).toMatchObject({ outcome: "timeout", fcp: null, lcp: null, timeOrigin: null, initial: ["lcp-image"], final: ["lcp-image"] });
  });

  it("reports an error, with no values, when an evaluate rejects", async () => {
    expect(await awaitPendingPaint(scriptedPage(["reject"]).page)).toMatchObject({
      outcome: "error",
      fcp: null,
      lcp: null,
      timeOrigin: null,
      initial: [],
    });
    // A navigation during the wait: the values could be another document's.
    expect(await awaitPendingPaint(scriptedPage([check({ fcp: 10, pending: ["fcp-vital"] }), "reject"]).page)).toMatchObject({
      outcome: "error",
      fcp: null,
      initial: ["fcp-vital"],
    });
  });

  it("does not wait on a hidden document", async () => {
    const { page, args } = scriptedPage([check({ visible: false })]);
    const r = await awaitPendingPaint(page);
    expect(args).toHaveLength(1);
    expect(r).toMatchObject({ outcome: "hidden", initial: [], final: [] });
  });

  it("reports hidden when the document went hidden during the wait", async () => {
    const { page } = scriptedPage([check({ pending: ["fcp"] }), check({ visible: false, frames: 2, flowing: 1 })]);
    expect((await awaitPendingPaint(page)).outcome).toBe("hidden");
  });

  it("times out a quick check that never answers within the cap", async () => {
    const r = await awaitPendingPaint(scriptedPage(["hang"]).page, { maxMs: 30 });
    expect(r).toMatchObject({ outcome: "timeout", collector: null, initial: [], final: [] });
  });
});

describe("paintWaitRecord", () => {
  const base: PaintWaitResult = {
    outcome: "reported",
    collector: true,
    timeOrigin: 1,
    fcp: 24,
    lcp: 1044,
    waitedMs: 215.94,
    frames: 3,
    flowing: 2,
    initial: ["lcp-image"],
    final: [],
  };

  it("rounds the wait and leaves out what is empty", () => {
    expect(paintWaitRecord(base)).toEqual({ outcome: "reported", waitedMs: 215.9, frames: 3, flowing: 2, pending: ["lcp-image"] });
  });

  it("keeps what was still pending, the content and the image, and drops an unknown frame count", () => {
    const rec = paintWaitRecord({
      ...base,
      outcome: "timeout",
      frames: null,
      flowing: undefined,
      initial: ["fcp", "lcp-image"],
      final: ["lcp-image"],
      content: "text",
      lcpImage: { url: "/hero.png", area: 360000, candidateSize: 9000, bpp: 22.86 },
    });
    expect(rec).toEqual({
      outcome: "timeout",
      waitedMs: 215.9,
      pending: ["fcp", "lcp-image"],
      stillPending: ["lcp-image"],
      content: "text",
      lcpImage: { url: "/hero.png", area: 360000, candidateSize: 9000, bpp: 22.86 },
    });
  });
});

describe("logSummary's paint-wait line", () => {
  const report = (paintWait?: PerfReport["paintWait"]): PerfReport =>
    ({
      title: "t",
      url: "http://x/",
      vitals: {},
      spans: [],
      appSpans: [],
      network: { requests: 0, encodedKB: 0, decodedKB: 0, thirdParty: { requests: 0, encodedKB: 0, domains: [] } },
      ...(paintWait ? { paintWait } : {}),
    }) as unknown as PerfReport;
  const printed = (r: PerfReport) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logSummary(r);
      return spy.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      spy.mockRestore();
    }
  };

  it("says when frames stopped before a pending paint was presented", () => {
    const out = printed(
      report({
        outcome: "timeout",
        waitedMs: 1003.6,
        pending: ["fcp", "lcp-image"],
        stillPending: ["fcp", "lcp-image"],
        lcpImage: { url: "http://x/img/hero.png", area: 1, candidateSize: 0, bpp: 1 },
      }),
    );
    expect(out).toContain("FCP not presented within 1004 ms (frames stopped)");
    expect(out).toMatch(/LCP may be under-read: \S*hero\.png loaded but was not presented within 1004 ms/);
  });

  it("prints nothing for a wait that got its paint, or ran out of frames", () => {
    expect(printed(report({ outcome: "reported", waitedMs: 30, pending: ["fcp"] }))).not.toContain("presented within");
    expect(printed(report({ outcome: "frames", waitedMs: 90, pending: ["fcp"], stillPending: ["fcp"] }))).not.toContain("presented within");
  });
});
