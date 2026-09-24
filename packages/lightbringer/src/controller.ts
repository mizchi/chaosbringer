import type { CDPSession, Page } from "playwright";
import { DEFAULT_EVALUATE_TIMEOUT_MS, DEFAULT_SETTLE_TIMEOUT_MS } from "./config";
import { BoundedEvaluator } from "./evaluate";
import { diffMetrics, type SpanRender } from "./analyze/render";
import { diffMemory, type SpanMemory } from "./analyze/memory";
import { PerfAccumulator } from "./accumulator";
import type { DrainPayload, PerfWindow } from "./browser";
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
// because storing them in the page would reset them on navigation. The in-page
// collector is drained at every span boundary into a node-side accumulator, so
// entries of documents the page navigated away from are kept.
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

/** An open span returned by PerfController.begin(); pass it to end(). */
export interface SpanHandle {
  readonly name: string;
  readonly startEpochMs: number;
  /** @internal */
  readonly id: number;
}

export interface PerfControllerOptions {
  /** settle used by measure()/end() when the call doesn't pass one (default: 2 rAF) */
  settle?: Settle;
  /** force a GC at span boundaries so memory deltas are retained-only */
  memGc?: boolean;
  /** max time to wait for settle before marking a span capped (default 5000) */
  settleTimeoutMs?: number;
  /** where drained in-page entries go (startSession shares one with the report) */
  accumulator?: PerfAccumulator;
  /**
   * max time one in-page read at a span boundary may take before its fallback
   * is used (default 5000). Bounds begin/end/drain on a page that cannot answer.
   */
  evaluateTimeoutMs?: number;
  /**
   * @internal the bounded evaluator to share (startSession passes the one its
   * finish() uses, so a stall seen by either short-circuits both).
   */
  evaluator?: BoundedEvaluator;
}

interface OpenSpan extends SpanHandle {
  before: Record<string, number>;
  budget?: Budget;
}

const NAV_TIMEOUT_MS = 2000;

export class PerfController {
  readonly spans: RawSpan[] = [];
  vitalsBudget: VitalsBudget = {};
  /** node-side store of every drained in-page entry (epoch ms) */
  readonly accumulator: PerfAccumulator;
  private settle: Settle;
  private memGc: boolean;
  private settleTimeoutMs: number;
  private evaluator: BoundedEvaluator;
  private open = new Map<number, OpenSpan>();
  private nextId = 1;
  private lastClosed?: { start: number; end: number };

  constructor(
    private page: Page,
    private client: CDPSession,
    /** a Settle (legacy positional form) or the full options */
    settleOrOptions?: Settle | PerfControllerOptions,
    /** legacy positional memGc; overridden by options.memGc */
    memGc?: boolean,
  ) {
    const opts: PerfControllerOptions =
      typeof settleOrOptions === "function"
        ? { settle: settleOrOptions }
        : (settleOrOptions ?? {});
    this.settle = opts.settle ?? defaultSettle;
    this.memGc = opts.memGc ?? memGc ?? false;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.accumulator = opts.accumulator ?? new PerfAccumulator();
    this.evaluator =
      opts.evaluator ??
      new BoundedEvaluator(page, opts.evaluateTimeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS);
    this.accumulator.setKeepFramesFrom(() => this.keepFramesFrom());
  }

  /** Declare upper bounds on web-vitals (LCP / INP / CLS / TTFB / FCP) for this test. */
  setVitalsBudget(budget: VitalsBudget): void {
    this.vitalsBudget = budget;
  }

  /**
   * Open a span now. Pair with end(). Unlike measure(), the region between begin
   * and end can be driven by anyone (a crawler step loop) and may navigate or
   * even close the page: end() still records the span with what is available.
   */
  async begin(name: string, opts: { budget?: Budget } = {}): Promise<SpanHandle> {
    // A collector installed with `frames: false` has no rAF probe running yet.
    // Start it before the baseline so this span's frames are recorded; a page
    // without a collector (or a navigation mid-call) just yields no frames.
    await this.evalSafe(
      () => {
        (window as unknown as PerfWindow).__perf?.startFrames?.();
        return null;
      },
      () => null,
    );
    // Bring the node side up to date first; frames before this span are dropped.
    await this.drain();
    if (this.open.size === 0 && this.lastClosed)
      this.accumulator.dropFramesAfter(this.lastClosed.end);
    const startEpochMs = await this.now();
    // With memGc, GC before the baseline so the delta starts from a clean heap.
    if (this.memGc) await this.gc();
    const before = await this.metrics();
    const span: OpenSpan = {
      id: this.nextId++,
      name,
      startEpochMs,
      before,
      budget: opts.budget,
    };
    this.open.set(span.id, span);
    return { id: span.id, name, startEpochMs };
  }

  /**
   * Close a span opened by begin(): settle (unless `settle: false`, meaning the
   * caller already waited — the span then ends now with capped=false), read the
   * end snapshot, drain the page, and record the span. Never throws because the
   * page navigated or closed; a second end() of the same handle is a no-op.
   */
  async end(
    handle: SpanHandle,
    opts: { settle?: Settle | false } = {},
  ): Promise<void> {
    const span = this.open.get(handle.id);
    if (!span) return;
    const capped =
      opts.settle === false
        ? false
        : await this.runSettle(opts.settle ?? this.settle);
    const endEpochMs = await this.now();
    // A closed page / gone target yields an empty snapshot (see metrics()).
    // Diffing against it would record negative deltas and an inverted trace
    // window, so fall back to the begin snapshot: zero deltas, empty window.
    const usable = (m: Record<string, number>) => m.Timestamp != null;
    const rawAfter = await this.metrics();
    const after = usable(span.before) && usable(rawAfter) ? rawAfter : span.before;
    // Memory uses a post-GC end snapshot under memGc (retained-only); render and
    // timing keep the un-GC'd `after` so the GC pause doesn't distort them.
    let memAfter = after;
    if (this.memGc && after !== span.before) {
      await this.gc();
      const m = await this.metrics();
      memAfter = usable(m) ? m : after;
    }
    // Drain while the span is still open, so its frames are kept.
    await this.drain();
    this.open.delete(span.id);
    this.lastClosed = { start: span.startEpochMs, end: endEpochMs };
    this.spans.push({
      name: span.name,
      startEpochMs: span.startEpochMs,
      endEpochMs,
      capped,
      render: diffMetrics(span.before, after),
      memory: diffMemory(span.before, memAfter),
      // getMetrics Timestamp (monotonic seconds) shares the clock with trace ts (μs).
      traceStartUs: (span.before.Timestamp ?? 0) * 1e6,
      traceEndUs: (after.Timestamp ?? 0) * 1e6,
      budget: span.budget,
    });
  }

  /**
   * Discard a span opened by begin() without recording it — for a driver that
   * opened the span and then decided not to act (a skipped step). Its entries
   * stay in the accumulator for any other open span. A no-op for a handle that
   * is unknown, already ended or already cancelled.
   */
  cancel(handle: SpanHandle): void {
    this.open.delete(handle.id);
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
    const handle = await this.begin(name, { budget: opts.budget });
    let result: T;
    try {
      result = await action();
    } catch (e) {
      // A failed action records no span (as before); forget the open handle.
      this.cancel(handle);
      throw e;
    }
    await this.end(handle, { settle: opts.settle });
    return result;
  }

  /**
   * Repeat the same operation N times, each recorded as a `${name}#${i}` span.
   * buildReport then checks whether memory (heap / listeners / DOM nodes /
   * ArrayBuffers) climbs monotonically across the repeats — the real leak signal,
   * which a single per-step delta can't separate from GC noise. Use memGc
   * (PERF_MEM=1) so each repeat's memory is measured after a forced GC.
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

  /**
   * Move everything the current document's collector buffered into the node-side
   * accumulator. Safe to call any time; a page without a collector (setContent,
   * about:blank) or a closed page contributes nothing.
   */
  async drain(): Promise<void> {
    const payload = await this.evalSafe(
      () => (window as unknown as PerfWindow).__perf?.drain?.() ?? null,
      () => null as DrainPayload | null,
    );
    if (payload) this.accumulator.add(payload);
  }

  /**
   * Epoch ms from the page's unpatched clock (see PerfStore.now). Without a
   * collector in the current document, use the node clock: the page's own
   * performance.now may be patched (clock-skew fault), node's cannot be.
   */
  async now(): Promise<number> {
    const t = await this.evalSafe<number | null>(
      () => {
        const p = (window as unknown as PerfWindow).__perf;
        return p && typeof p.now === "function" ? p.now() : null;
      },
      () => null,
    );
    return typeof t === "number" ? t : Date.now();
  }

  /** Frames before this epoch are irrelevant to any span that can still use them. */
  private keepFramesFrom(): number {
    let min = Infinity;
    for (const s of this.open.values()) min = Math.min(min, s.startEpochMs);
    if (min !== Infinity) return min;
    // Nothing open: keep late arrivals (e.g. a pagehide emit) for the last span.
    return this.lastClosed ? this.lastClosed.start : Infinity;
  }

  /**
   * page.evaluate that tolerates navigation, closure and a page that cannot
   * answer: on failure (typically "Execution context was destroyed") retry once
   * after domcontentloaded; on timeout (evaluateTimeoutMs) give up at once — a
   * retry would only wait for the same missing context again. Falls back
   * otherwise. Never throws.
   */
  private async evalSafe<R>(fn: () => R, fallback: () => R): Promise<R> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.page.isClosed()) break;
      const r = await this.evaluator.attempt(fn);
      if (r.kind === "ok") return r.value;
      if (r.kind === "timeout") break;
      if (this.page.isClosed() || attempt > 0) break;
      await this.page
        .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
        .catch(() => {});
    }
    return fallback();
  }

  /** Run settle but give up after settleTimeoutMs. Returns true if it capped. */
  private async runSettle(settle: Settle): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.settleTimeoutMs);
    });
    const done = settle(this.page).then(
      () => false,
      async (e: unknown) => {
        // Navigation / closure mid-settle is not the caller's bug: retry once on
        // the new document (it may still be what the caller wants to wait for).
        if (this.page.isClosed()) return false;
        if (!/Execution context was destroyed|navigat/i.test(String(e))) throw e;
        await this.page
          .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
          .catch(() => {});
        return settle(this.page).then(
          () => false,
          () => false,
        );
      },
    );
    try {
      return await Promise.race([done, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Force a GC so subsequent memory metrics reflect retained, not pending-collection, memory. */
  private async gc(): Promise<void> {
    // Twice: one collectGarbage leaves recently-promoted objects uncollected, so a
    // dropped allocation can still inflate JSHeapUsedSize after a single pass.
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
    await this.client.send("HeapProfiler.collectGarbage").catch(() => {});
  }

  private async metrics(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    try {
      const res = (await this.client.send("Performance.getMetrics")) as {
        metrics: Array<{ name: string; value: number }>;
      };
      for (const m of res.metrics) out[m.name] = m.value;
    } catch {
      /* target closed: record the span with what is available */
    }
    return out;
  }
}
