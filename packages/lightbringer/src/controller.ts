import type { CDPSession, Page } from "playwright";
import { MEM_GC, SETTLE_TIMEOUT_MS } from "./config";
import { diffMetrics, type SpanRender } from "./analyze/render";
import { diffMemory, type SpanMemory } from "./analyze/memory";
import type { Budget, Settle, VitalsBudget } from "./report-types";

/** Default settle: wait for two animation frames (ensures at least one painted frame). */
export const defaultSettle: Settle = (page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

// ---------------------------------------------------------------------------
// Span controller. Span boundaries are kept on the node side in epoch ms,
// because storing them in the page would reset them on navigation.
// ---------------------------------------------------------------------------

export interface RawSpan {
  name: string;
  startEpochMs: number;
  endEpochMs: number;
  capped: boolean;
  render: SpanRender;
  memory: SpanMemory;
  /** span window in trace clock (monotonic μs) for correlation / drilldown */
  traceStartUs: number;
  traceEndUs: number;
  budget?: Budget;
}

export class PerfController {
  readonly spans: RawSpan[] = [];
  vitalsBudget: VitalsBudget = {};
  constructor(
    private page: Page,
    private client: CDPSession,
    private settle: Settle = defaultSettle,
    /** force a GC at span boundaries so memory deltas are retained-only (PERF_MEM) */
    private memGc: boolean = MEM_GC,
  ) {}

  /** Declare upper bounds on web-vitals (LCP / INP / CLS / TTFB / FCP) for this test. */
  setVitalsBudget(budget: VitalsBudget): void {
    this.vitalsBudget = budget;
  }

  /**
   * Measure a named operation. Runs action, waits for the page to settle, and
   * records the region as one span. Include your waitFor assertions inside
   * action so the span covers "until the operation is done", then its
   * network / CPU / render breakdown can be correlated afterwards.
   */
  async measure<T>(
    name: string,
    action: () => Promise<T>,
    opts: { settle?: Settle; budget?: Budget } = {},
  ): Promise<T> {
    const startEpochMs = await this.now();
    // With PERF_MEM, GC before the baseline so the delta starts from a clean heap.
    if (this.memGc) await this.gc();
    const before = await this.metrics();
    const result = await action();
    const capped = await this.runSettle(opts.settle ?? this.settle);
    const endEpochMs = await this.now();
    const after = await this.metrics();
    // Memory uses a post-GC end snapshot under PERF_MEM (retained-only); render and
    // timing keep the un-GC'd `after` so the GC pause doesn't distort them.
    let memAfter = after;
    if (this.memGc) {
      await this.gc();
      memAfter = await this.metrics();
    }
    this.spans.push({
      name,
      startEpochMs,
      endEpochMs,
      capped,
      render: diffMetrics(before, after),
      memory: diffMemory(before, memAfter),
      // getMetrics Timestamp (monotonic seconds) shares the clock with trace ts (μs).
      traceStartUs: (before.Timestamp ?? 0) * 1e6,
      traceEndUs: (after.Timestamp ?? 0) * 1e6,
      budget: opts.budget,
    });
    return result;
  }

  /**
   * Repeat the same operation N times, each recorded as a `${name}#${i}` span.
   * buildReport then checks whether memory (heap / listeners / DOM nodes /
   * ArrayBuffers) climbs monotonically across the repeats — the real leak signal,
   * which a single per-step delta can't separate from GC noise. Use PERF_MEM=1 so
   * each repeat's memory is measured after a forced GC (retained-only).
   */
  async measureRepeat(
    name: string,
    action: () => Promise<void>,
    opts: { times?: number; settle?: Settle; budget?: Budget } = {},
  ): Promise<void> {
    const times = opts.times ?? 3;
    for (let i = 0; i < times; i++) {
      await this.measure(`${name}#${i}`, action, {
        settle: opts.settle,
        budget: opts.budget,
      });
    }
  }

  /** Run settle but give up after SETTLE_TIMEOUT_MS. Returns true if it capped. */
  private async runSettle(settle: Settle): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SETTLE_TIMEOUT_MS);
    });
    const done = settle(this.page).then(() => false);
    const capped = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return capped;
  }

  private now(): Promise<number> {
    return this.page.evaluate(() => performance.timeOrigin + performance.now());
  }

  /** Force a GC so subsequent memory metrics reflect retained, not pending-collection, memory. */
  private async gc(): Promise<void> {
    // Twice: one collectGarbage leaves recently-promoted objects uncollected, so a
    // dropped allocation can still inflate JSHeapUsedSize after a single pass.
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
  }

  private async metrics(): Promise<Record<string, number>> {
    const res = (await this.client.send("Performance.getMetrics")) as {
      metrics: Array<{ name: string; value: number }>;
    };
    const out: Record<string, number> = {};
    for (const m of res.metrics) out[m.name] = m.value;
    return out;
  }
}
