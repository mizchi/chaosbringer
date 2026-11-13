import type { Page } from "playwright";

// ---------------------------------------------------------------------------
// Bounded page.evaluate. Playwright's evaluate has no timeout of its own: after
// a navigation whose document request is never answered, it waits for the new
// document's execution context, which only appears when Chromium gives up on
// the request (minutes later). Measurement must never hold its caller that
// long, so every in-page read lightbringer issues goes through here.
// ---------------------------------------------------------------------------

/** What one bounded evaluate produced. */
export type EvaluateOutcome<R> =
  | { kind: "ok"; value: R }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

const TIMED_OUT = Symbol("timeout");

/**
 * Race p against a timer of ms; onTimeout's value wins when the timer fires
 * first. The timer is cleared either way so a settled race never keeps the
 * event loop alive. p itself is not cancelled (callers decide what to do with
 * the abandoned promise).
 */
export async function raceTimeout<T, F>(p: Promise<T>, ms: number, onTimeout: () => F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BoundedEvaluator {
  /**
   * The evaluate that last timed out, while it is still pending. Playwright
   * runs a page's evaluates against the same (missing) context, so a new one
   * issued now would queue behind it and time out too; returning at once
   * turns N reads on a hung page into one bounded wait instead of N. Cleared
   * as soon as it settles, i.e. when the page can answer again.
   */
  private pendingStall: Promise<void> | undefined;

  constructor(
    private readonly page: Page,
    readonly timeoutMs: number,
  ) {}

  /**
   * A read timed out and is still pending: the page cannot answer now, and
   * every attempt() returns a timeout at once until it does. A caller about to
   * issue its own evaluate outside this evaluator (finish()'s paint wait)
   * checks this first.
   */
  get stalled(): boolean {
    return this.pendingStall !== undefined;
  }

  /**
   * Take over an evaluate issued outside this evaluator that has not answered
   * for `spentMs` (finish()'s paint check on a hung page). Waits for it for the
   * rest of one timeout; when it still has not settled, it becomes the pending
   * stall, as if attempt() had issued it, so the reads after it return at once
   * and the hung page costs one bounded wait in all, not one more.
   */
  async adopt(pending: Promise<unknown>, spentMs: number): Promise<void> {
    if (this.pendingStall) return;
    const settled = pending.then(
      () => {},
      () => {},
    );
    const r = await raceTimeout(settled, Math.max(0, this.timeoutMs - spentMs), (): typeof TIMED_OUT => TIMED_OUT);
    if (r !== TIMED_OUT) return;
    this.track(settled);
  }

  /** Remember an abandoned evaluate as the pending stall until it settles. */
  private track(settled: Promise<void>): void {
    this.pendingStall = settled;
    void settled.then(() => {
      if (this.pendingStall === settled) this.pendingStall = undefined;
    });
  }

  /** page.evaluate(fn) that resolves within timeoutMs and never rejects. */
  async attempt<R>(fn: () => R | Promise<R>): Promise<EvaluateOutcome<R>> {
    if (this.pendingStall) return { kind: "timeout" };
    const pending = this.page.evaluate(fn) as Promise<R>;
    const result = await raceTimeout(
      pending.then(
        (value): EvaluateOutcome<R> => ({ kind: "ok", value }),
        (error: unknown): EvaluateOutcome<R> => ({ kind: "error", error }),
      ),
      this.timeoutMs,
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    if (result !== TIMED_OUT) return result;
    // Keep the abandoned evaluate observed (its eventual rejection must not
    // surface as unhandled) and remember it until it settles.
    this.track(
      pending.then(
        () => {},
        () => {},
      ),
    );
    return { kind: "timeout" };
  }

  /** attempt() reduced to a value: the fallback on error or timeout. */
  async evaluate<R>(fn: () => R | Promise<R>, fallback: () => R): Promise<R> {
    const r = await this.attempt(fn);
    return r.kind === "ok" ? r.value : fallback();
  }
}
