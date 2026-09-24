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

export class BoundedEvaluator {
  /**
   * The evaluate that last timed out, while it is still pending. Playwright
   * runs a page's evaluates against the same (missing) context, so a new one
   * issued now would queue behind it and time out too; returning at once
   * turns N reads on a hung page into one bounded wait instead of N. Cleared
   * as soon as it settles, i.e. when the page can answer again.
   */
  private stalled: Promise<void> | undefined;

  constructor(
    private readonly page: Page,
    readonly timeoutMs: number,
  ) {}

  /** page.evaluate(fn) that resolves within timeoutMs and never rejects. */
  async attempt<R>(fn: () => R | Promise<R>): Promise<EvaluateOutcome<R>> {
    if (this.stalled) return { kind: "timeout" };
    const pending = this.page.evaluate(fn) as Promise<R>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
    });
    try {
      const result = await Promise.race([
        pending.then(
          (value): EvaluateOutcome<R> => ({ kind: "ok", value }),
          (error: unknown): EvaluateOutcome<R> => ({ kind: "error", error }),
        ),
        timeout,
      ]);
      if (result !== TIMED_OUT) return result;
      // Keep the abandoned evaluate observed (its eventual rejection must not
      // surface as unhandled) and remember it until it settles.
      const stalled = pending.then(
        () => {},
        () => {},
      );
      this.stalled = stalled;
      void stalled.then(() => {
        if (this.stalled === stalled) this.stalled = undefined;
      });
      return { kind: "timeout" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** attempt() reduced to a value: the fallback on error or timeout. */
  async evaluate<R>(fn: () => R | Promise<R>, fallback: () => R): Promise<R> {
    const r = await this.attempt(fn);
    return r.kind === "ok" ? r.value : fallback();
  }
}
