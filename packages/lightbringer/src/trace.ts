// In-app measurement primitive. Under the hood it is the browser-standard
// User Timing API (performance.mark / performance.measure). Leaving these calls
// in production has near-zero overhead and they show up in the DevTools
// Performance panel as User Timing entries.
//
// Collection is done by the collector's PerformanceObserver({ type: "measure" }).
// Nothing is sent to a server. Put attributes in the measure detail and the OTel
// conversion layer (otel.ts) picks them up as span attributes.
//
// Note: PerformanceMeasure.toJSON() does NOT include detail, so the collector
// reads entry.detail directly inside the observer callback (not via JSON).

import type { AttrValue } from "./otel";

export interface Span {
  setAttribute(key: string, value: AttrValue): void;
  end(): void;
}

let markCounter = 0;

const hasUserTiming =
  typeof performance !== "undefined" &&
  typeof performance.mark === "function" &&
  typeof performance.measure === "function";

const noopSpan: Span = {
  setAttribute() {},
  end() {},
};

/**
 * Start a span. On end() it emits performance.measure(name, { detail: { attributes } }).
 * Use it to name a region of code you want to measure.
 */
export function startSpan(
  name: string,
  attributes: Record<string, AttrValue> = {},
): Span {
  if (!hasUserTiming) return noopSpan;

  const startMark = `⁣${name}⁣${++markCounter}`;
  performance.mark(startMark);
  const attrs: Record<string, AttrValue> = { ...attributes };

  let ended = false;
  return {
    setAttribute(key, value) {
      attrs[key] = value;
    },
    end() {
      if (ended) return;
      ended = true;
      // __lbSpan sentinel distinguishes our measures from those emitted by
      // frameworks (React, Radix, etc.). The collector only collects measures
      // that carry this flag.
      performance.measure(name, {
        start: startMark,
        detail: { __lbSpan: true, attributes: attrs },
      });
      performance.clearMarks(startMark);
    },
  };
}

/**
 * Wrap fn in a span. Works for both sync and async fn and closes the span on throw.
 * @example const stats = await withSpan("loadStats", () => fetchStats(), { id });
 */
export function withSpan<T>(
  name: string,
  fn: () => T,
  attributes: Record<string, AttrValue> = {},
): T {
  const span = startSpan(name, attributes);
  let result: T;
  try {
    result = fn();
  } catch (e) {
    span.end();
    throw e;
  }
  if (result instanceof Promise) {
    return result.finally(() => span.end()) as unknown as T;
  }
  span.end();
  return result;
}
