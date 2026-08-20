/**
 * Measure what the current machine can honour, so timing values can be solved
 * instead of guessed.
 *
 * Everything is measured through the same mechanisms the fault layers use —
 * `route()` + `setTimeout` + `fallback()` for a delay, `AbortSignal` for a
 * bounded hang, `waitForTimeout` for the probe window — because the number
 * that matters is what the *page* experiences, not what a bare timer does.
 *
 * Two properties this deliberately has:
 *
 *   - It refuses to report numbers it did not actually produce. If the route
 *     never intercepted (a mis-scoped matcher measures nothing), the run
 *     fails loudly instead of reporting a floor of 4ms.
 *   - It takes an *envelope over repeated runs*, because a warm run
 *     under-reports the tail: on the container this was written against, a
 *     warm run measured 14ms where the cold one measured 107ms.
 */

import { chromium, type Route } from "playwright";
import type { TimingProfile } from "../timing.js";

export interface CalibrateOptions {
  /** Origin to measure against. Any page that can issue a same-origin fetch. */
  url: string;
  /** Path the probe fetches. Defaults to the page URL itself. */
  probePath?: string;
  /** Calibration runs to take the envelope over. Default 3. */
  runs?: number;
  /** Fetches per nominal delay, per run. Default 20. */
  samples?: number;
  /** Nominal delays to probe, in ms. */
  nominals?: readonly number[];
  headless?: boolean;
  /** Progress sink. */
  onProgress?: (message: string) => void;
}

export interface CalibrationSample {
  nominal: number;
  observedMin: number;
  observedMax: number;
  overheadMin: number;
  overheadMax: number;
}

export interface CalibrationRun {
  delay: CalibrationSample[];
  tight: CalibrationSample[];
  fixedPerPlanMs: number;
}

export interface CalibrationResult {
  profile: TimingProfile;
  runs: CalibrationRun[];
}

const DEFAULT_NOMINALS = [0, 20, 50, 100, 250, 1000] as const;

function sample(nominal: number, values: readonly number[]): CalibrationSample {
  const min = Math.round(Math.min(...values));
  const max = Math.round(Math.max(...values));
  return {
    nominal,
    observedMin: min,
    observedMax: max,
    overheadMin: min - nominal,
    overheadMax: max - nominal,
  };
}

async function oneRun(opts: CalibrateOptions): Promise<CalibrationRun> {
  const nominals = opts.nominals ?? DEFAULT_NOMINALS;
  const samples = opts.samples ?? 20;
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const page = await browser.newPage();
    let nominal = 0;
    const probe = opts.probePath ?? new URL(opts.url).pathname;

    // A RegExp, not a glob: a glob will not match the cache-busting query the
    // probe appends, and a matcher that silently matches nothing produces a
    // profile that claims this environment has no overhead at all.
    await page.route(new RegExp(probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), async (route: Route) => {
      if (nominal > 0) await new Promise((r) => setTimeout(r, nominal));
      await route.fallback();
    });
    await page.goto(opts.url, { waitUntil: "domcontentloaded" });

    const delay: CalibrationSample[] = [];
    for (const n of nominals) {
      nominal = n;
      const values = await page.evaluate(
        async ({ path, count }) => {
          const out: number[] = [];
          for (let i = 0; i < count; i++) {
            const t0 = performance.now();
            await fetch(`${path}?__calib=${i}-${Math.random()}`);
            out.push(performance.now() - t0);
          }
          return out;
        },
        { path: probe, count: samples },
      );
      const s = sample(n, values);
      if (n > 0 && s.observedMin < n) {
        throw new Error(
          `chaosbringer: calibration probe never intercepted — a nominal ${n}ms delay was observed ` +
            `in ${s.observedMin}ms. Check --probe-path (currently "${probe}"); a profile measured ` +
            `without interception would claim this environment has no overhead.`,
        );
      }
      delay.push(s);
      opts.onProgress?.(`delay ${n}ms -> ${s.observedMin}..${s.observedMax}ms`);
    }
    nominal = 0;

    // Tight paths: AbortSignal firing, and the probe window itself.
    const tight: CalibrationSample[] = [];
    for (const bound of [200, 1000]) {
      const values = await page.evaluate(async (ms) => {
        const out: number[] = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await new Promise<void>((resolve) => {
            const signal = AbortSignal.timeout(ms);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          out.push(performance.now() - t0);
        }
        return out;
      }, bound);
      tight.push(sample(bound, values));
    }
    for (const window of [100, 500]) {
      const values: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await page.waitForTimeout(window);
        values.push(Date.now() - t0);
      }
      tight.push(sample(window, values));
    }
    opts.onProgress?.(`tight paths -> max overhead ${Math.max(...tight.map((t) => t.overheadMax))}ms`);

    // Fixed per-plan cost: a whole plan pays this before it does anything.
    const fixedSamples: number[] = [];
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const b = await chromium.launch({ headless: opts.headless ?? true });
      const p = await b.newPage();
      await p.goto(opts.url, { waitUntil: "networkidle" });
      await p.close();
      await b.close();
      fixedSamples.push(Date.now() - t0);
    }
    const fixedPerPlanMs = Math.max(...fixedSamples);
    opts.onProgress?.(`fixed per plan -> ${fixedPerPlanMs}ms`);

    return { delay, tight, fixedPerPlanMs };
  } finally {
    await browser.close();
  }
}

/** Run the calibration `runs` times and return the conservative envelope. */
export async function calibrateTiming(opts: CalibrateOptions): Promise<CalibrationResult> {
  const runCount = opts.runs ?? 3;
  const runs: CalibrationRun[] = [];
  for (let i = 0; i < runCount; i++) {
    opts.onProgress?.(`--- run ${i + 1}/${runCount} ---`);
    runs.push(await oneRun(opts));
  }
  const profile = envelope(runs);
  // A warm, idle machine flatters the tail: the container this was written
  // against measured 13ms over two warm runs and 107ms on a cold one. Say so,
  // rather than letting an optimistic profile turn into flaky plans.
  if (profile.delayTailMs < profile.delayFloorMs * 4 || runCount < 3) {
    opts.onProgress?.(
      `note: a ${profile.delayTailMs}ms tail over ${runCount} run(s) is probably optimistic — ` +
        `a cold run measures several times that. Take at least 3 runs, and keep the solver's ` +
        `safety factor at 2 or above.`,
    );
  }
  return { profile, runs };
}

/**
 * The envelope: floors at their minimum (the best case is the real floor),
 * tails and fixed costs at their maximum across runs. Pure, so the
 * aggregation is testable without a browser.
 */
export function envelope(runs: readonly CalibrationRun[]): TimingProfile {
  if (runs.length === 0) throw new Error("chaosbringer: no calibration runs to aggregate");
  const delays = runs.flatMap((r) => r.delay);
  const tights = runs.flatMap((r) => r.tight);
  return {
    delayFloorMs: Math.min(...delays.map((d) => d.overheadMin)),
    delayTailMs: Math.max(...delays.map((d) => d.overheadMax)),
    tightTailMs: Math.max(...tights.map((t) => t.overheadMax)),
    fixedPerPlanMs: Math.max(...runs.map((r) => r.fixedPerPlanMs)),
    runs: runs.length,
    measuredAt: new Date().toISOString(),
    env: { node: process.version, platform: process.platform },
  };
}
