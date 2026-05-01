/**
 * Coverage-guided action selection (AFL flavour).
 *
 * V8 precise coverage (CDP `Profiler.startPreciseCoverage` / `takePreciseCoverage`)
 * gives us per-script function-level coverage. We use it as a feedback signal:
 *
 *   1. Before each page visit, take a snapshot of the global covered-function set.
 *   2. Run the page (load + chaos actions), then take coverage again.
 *   3. The delta is the set of functions newly executed on this page.
 *   4. Attribute the delta to the page URL and to whichever action target
 *      preceded the coverage growth (single-action attribution per page).
 *   5. On the next page visit, multiply each action target's weight by a
 *      novelty bonus derived from its historical coverage contribution.
 *
 * Reproducibility: this module never consumes the crawler RNG. Same seed →
 * same chaos action sequence → same coverage deltas → same future weights.
 * Reproducibility now spans `(seed, coverageFeedback)` rather than `seed`
 * alone — when feedback is enabled, the weighted-pick output diverges from
 * the no-feedback baseline because weights are different.
 */

import type { CDPSession } from "playwright";

/**
 * One entry in the V8 precise-coverage report we care about. Many other
 * fields exist on the actual CDP response — we keep only what survives
 * a JSON round-trip and what the signature function reads.
 */
export interface CoverageScriptResult {
  scriptId: string;
  url: string;
  functions: ReadonlyArray<{
    functionName: string;
    ranges: ReadonlyArray<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}

/**
 * Convert a V8 precise-coverage snapshot to a stable set of "function
 * fingerprints" — `<scriptUrl>:<functionName>:<startOffset>`. Functions
 * that didn't run (every range has `count: 0`) are excluded; functions
 * that ran at least once contribute one fingerprint regardless of how
 * many ranges they cover.
 *
 * scriptUrl is preferred over scriptId because scriptIds are reassigned
 * across CDP sessions and per-page reloads.
 */
export function coverageSignature(scripts: ReadonlyArray<CoverageScriptResult>): Set<string> {
  const out = new Set<string>();
  for (const script of scripts) {
    // Anonymous / inline scripts have no `url` — fall back to `scriptId`
    // so we still capture the function execution. Skip only when both are
    // empty (shouldn't happen in practice).
    const id = script.url && script.url.length > 0 ? script.url : `script:${script.scriptId}`;
    if (id === "script:") continue;
    for (const fn of script.functions) {
      const ran = fn.ranges.some((r) => r.count > 0);
      if (!ran) continue;
      const start = fn.ranges[0]?.startOffset ?? 0;
      out.add(`${id} ${fn.functionName} ${start}`);
    }
  }
  return out;
}

/** Set difference: elements of `next` that are not in `prev`. */
export function coverageDelta(prev: ReadonlySet<string>, next: ReadonlySet<string>): Set<string> {
  const added = new Set<string>();
  for (const fp of next) {
    if (!prev.has(fp)) added.add(fp);
  }
  return added;
}

/**
 * Convert a historical novelty score into a multiplicative weight factor.
 *
 *   factor = 1 + boost · log(1 + score)
 *
 * Logarithmic so that a target with a huge historical contribution doesn't
 * crush every other target's weight. `boost: 0` disables the feedback
 * (factor === 1). `boost: 2` is a moderate default — a target with score
 * 5 ends up at ~`1 + 2·log(6) ≈ 4.6` × weight; score 100 caps around `~10×`.
 */
export function noveltyMultiplier(score: number, boost: number): number {
  if (boost <= 0 || score <= 0) return 1;
  return 1 + boost * Math.log1p(score);
}

/**
 * Identifier for a single action target on a specific URL. Used as the key
 * in the per-target novelty Map. We include the URL because the same
 * `selector` (e.g. `nav > a:nth-child(2)`) may map to entirely different
 * actions across pages.
 */
export function targetKey(url: string, selector: string): string {
  return `${url} ${selector}`;
}

/**
 * Snapshot of running coverage state, exposed in `report.coverage`.
 */
export interface CoverageReport {
  /** Total distinct function fingerprints seen so far in this run. */
  totalFunctions: number;
  /** Number of pages whose visit yielded at least one new function. */
  pagesWithNewCoverage: number;
  /** Top action targets by historical novelty, sorted desc. */
  topNovelTargets: Array<{
    url: string;
    selector: string;
    score: number;
  }>;
}

/**
 * Build the report-shaped summary from the in-flight running state.
 */
export function summarizeCoverage(state: {
  globalCovered: ReadonlySet<string>;
  pageDeltas: ReadonlyArray<{ url: string; addedCount: number }>;
  targetNovelty: ReadonlyMap<string, number>;
  topN?: number;
}): CoverageReport {
  const top = [...state.targetNovelty.entries()]
    .map(([key, score]) => {
      const sep = key.indexOf(" ");
      const url = sep >= 0 ? key.slice(0, sep) : key;
      const selector = sep >= 0 ? key.slice(sep + 1) : "";
      return { url, selector, score };
    })
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url) || a.selector.localeCompare(b.selector))
    .slice(0, state.topN ?? 20);

  return {
    totalFunctions: state.globalCovered.size,
    pagesWithNewCoverage: state.pageDeltas.filter((d) => d.addedCount > 0).length,
    topNovelTargets: top,
  };
}

/**
 * Lightweight wrapper around the CDP coverage API. The crawler holds one
 * collector per page and discards it when the page closes.
 */
export class CoverageCollector {
  private started = false;

  constructor(private readonly cdp: CDPSession) {}

  async start(): Promise<void> {
    if (this.started) return;
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true,
      allowTriggeredUpdates: false,
    });
    this.started = true;
  }

  async take(): Promise<Set<string>> {
    if (!this.started) return new Set();
    // takePreciseCoverage returns a snapshot since startPreciseCoverage and
    // does NOT reset the underlying counters — coverage accumulates over the
    // lifetime of the collector. We diff against the previous snapshot to
    // get per-action deltas.
    const result = (await this.cdp.send("Profiler.takePreciseCoverage")) as {
      result: ReadonlyArray<CoverageScriptResult>;
    };
    return coverageSignature(result.result);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    try {
      await this.cdp.send("Profiler.stopPreciseCoverage");
    } finally {
      this.started = false;
    }
  }
}
