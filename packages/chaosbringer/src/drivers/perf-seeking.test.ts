import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import type { ActionResult, CrawlReport, LastActionPerf } from "../types.js";
import type { Rng } from "../random.js";
import {
  PERF_SEEKING_COST_FLOOR_MS,
  PERF_SEEKING_COST_THRESHOLD_MS,
  perfSeekingBucketCost,
  perfSeekingCost,
  perfSeekingDriver,
} from "./perf-seeking.js";
import type { DriverCandidate, DriverHistoryEntry, DriverStep } from "./types.js";

const URL = "http://localhost:4000/app";
const candidates: DriverCandidate[] = ["#fast1", "#fast2", "#slow", "#fast3"].map(
  (selector, index) => ({ index, selector, description: selector, type: "button", weight: 1 }),
);
const key = (selector: string) => `/app :: click ${selector}`;

const facts = (selector: string, blockingMs: number, interactionMs?: number): LastActionPerf => ({
  key: key(selector),
  durationMs: blockingMs + 10,
  cpu: { blockingMs, longTaskCount: blockingMs > 0 ? 1 : 0 },
  ...(interactionMs !== undefined
    ? {
        interaction: {
          count: 1,
          maxDurationMs: interactionMs,
          type: "click",
          inputDelayMs: 0,
          processingMs: interactionMs,
          presentationMs: 0,
        },
      }
    : {}),
  network: { requestCount: 0, encodedKB: 0 },
});

const ran: DriverHistoryEntry = { type: "click", target: "x", success: true };

const step = (o: Partial<DriverStep> = {}): DriverStep => ({
  url: URL,
  currentUrl: URL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: {} as any,
  candidates,
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => Buffer.from([]),
  invariantViolations: [],
  ...o,
});

async function pickIndex(driver: ReturnType<typeof perfSeekingDriver>, s: DriverStep): Promise<number> {
  const pick = await driver.selectAction(s);
  if (!pick || pick.kind !== "select") throw new Error("expected a select pick");
  return pick.index;
}

function priorWith(spans: Array<[string, number]>): Pick<CrawlReport, "actions"> {
  const actions = spans.map(([selector, blockingMs]) => {
    const f = facts(selector, blockingMs);
    return { type: "click", selector, success: true, timestamp: 0, perf: f } as unknown as ActionResult;
  });
  return { actions };
}

describe("perfSeekingCost", () => {
  it("takes the larger of blocking time and interaction latency, and counts a missing interaction as 0", () => {
    // Not the sum: a busy handler is in both, and its interaction often
    // arrives after the step read the span (see perfSeekingCost).
    expect(perfSeekingCost(facts("#a", 50, 120))).toBe(120);
    expect(perfSeekingCost(facts("#a", 200, 208))).toBe(208);
    expect(perfSeekingCost(facts("#a", 200))).toBe(200);
    expect(perfSeekingCost(facts("#a", 0, 400))).toBe(400);
  });
});

describe("perfSeekingDriver", () => {
  it("returns null with no candidates", async () => {
    expect(await perfSeekingDriver().selectAction(step({ candidates: [] }))).toBeNull();
  });

  it("picks uniformly while nothing on the screen is measured", async () => {
    const driver = perfSeekingDriver();
    const counts = [0, 0, 0, 0];
    const rng = createRng(7);
    for (let i = 0; i < 400; i++) counts[await pickIndex(driver, step({ rng }))]! += 1;
    for (const c of counts) expect(c).toBeGreaterThan(60);
  });

  it("weights measured candidates by their observed cost", async () => {
    // Every other candidate measured cheap, `#slow` expensive; epsilon 0
    // so every pick is from the weighting.
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(3);
    for (const [sel, ms] of [["#fast1", 0], ["#fast2", 0], ["#fast3", 0], ["#slow", 300]] as const) {
      await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts(sel, ms) }));
    }
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 300; i++) counts[await pickIndex(driver, step({ rng, history: [ran] }))]! += 1;
    // 301 : 1 : 1 : 1 — the slow one takes almost every pick.
    expect(counts[2]).toBeGreaterThan(280);
  });

  it("reads interaction latency too, not only blocking time", async () => {
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(5);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0, 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 0, 400) }));
    const two = candidates.filter((c) => c.selector === "#fast1" || c.selector === "#slow");
    let slow = 0;
    for (let i = 0; i < 200; i++) {
      if ((await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))) === 2) slow += 1;
    }
    expect(slow).toBeGreaterThan(190);
  });

  it("keeps a floor under a measured-cheap key so it is still picked sometimes", async () => {
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(11);
    const two = candidates.slice(0, 2);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast2", 0) }));
    const counts = [0, 0];
    for (let i = 0; i < 200; i++) counts[await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))]! += 1;
    // Both measured at 0: equal weight (the floor), not a zero-sum fallback.
    expect(PERF_SEEKING_COST_FLOOR_MS).toBeGreaterThan(0);
    expect(counts[0]).toBeGreaterThan(60);
    expect(counts[1]).toBeGreaterThan(60);
  });

  it("counts one measurement once, however many attempts see it", async () => {
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(2);
    // One 300ms measurement of #fast1 handed to three attempts of a step,
    // then a 0ms one: counted once, #fast1's mean is 150; counted three
    // times it would be 225. #fast2 at 250 shares the bucket of 225 (213–319)
    // and sits one above that of 150 (142–213).
    const costly = facts("#fast1", 300);
    for (let i = 0; i < 3; i++) await driver.selectAction(step({ rng, history: [ran], lastActionPerf: costly }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast2", 250) }));
    const two = candidates.slice(0, 2);
    let fast2 = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if ((await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))) === 1) fast2 += 1;
    }
    // Expected 261/435 = 0.60 counted once, 0.5 counted thrice.
    expect(fast2 / n).toBeGreaterThan(0.55);
  });

  it("weights an unmeasured candidate as the average measured one on the screen", async () => {
    // #slow at 1000 (bucketed ~880) and #fast1 at 0 average ~440, so #fast2
    // and #fast3 weigh ~441 each against ~881 and 1: half of the picks go to
    // the two untried.
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(9);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 1000) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    let untried = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const pick = await pickIndex(driver, step({ rng, history: [ran] }));
      if (pick === 1 || pick === 3) untried += 1;
    }
    expect(untried / n).toBeGreaterThan(0.45);
    expect(untried / n).toBeLessThan(0.55);
  });

  it("explores unmeasured candidates with probability epsilon on top", async () => {
    // Same screen as above with epsilon 0.5: 0.5 + 0.5 * 0.5 of the picks.
    const driver = perfSeekingDriver({ epsilon: 0.5 });
    const rng = createRng(10);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 1000) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    let untried = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const pick = await pickIndex(driver, step({ rng, history: [ran] }));
      if (pick === 1 || pick === 3) untried += 1;
    }
    expect(untried / n).toBeGreaterThan(0.7);
    expect(untried / n).toBeLessThan(0.8);
  });

  it("with epsilon 1, always picks an untried candidate while there is one", async () => {
    const driver = perfSeekingDriver({ epsilon: 1 });
    const rng = createRng(4);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 5000) }));
    for (let i = 0; i < 50; i++) expect(await pickIndex(driver, step({ rng, history: [ran] }))).not.toBe(2);
  });

  it("is deterministic for a seed", async () => {
    const run = async () => {
      const driver = perfSeekingDriver();
      const rng = createRng(42);
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const last = i % 3 === 0 ? facts(candidates[i % 4]!.selector, i * 10) : undefined;
        out.push(await pickIndex(driver, step({ rng, history: [ran], ...(last ? { lastActionPerf: last } : {}) })));
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it("seeds its costs from a prior report's action spans", async () => {
    const onWarn = vi.fn();
    const driver = perfSeekingDriver({
      epsilon: 0,
      prior: priorWith([["#fast1", 0], ["#slow", 250], ["#slow", 350]]),
      onWarn,
    });
    const rng = createRng(8);
    const two = candidates.filter((c) => c.selector === "#fast1" || c.selector === "#slow");
    let slow = 0;
    // A page's first step: no history, no measurement yet — the prior alone.
    for (let i = 0; i < 200; i++) if ((await pickIndex(driver, step({ rng, candidates: two }))) === 2) slow += 1;
    expect(slow).toBeGreaterThan(190);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("matches a prior taken on another origin: keys drop it", async () => {
    const driver = perfSeekingDriver({
      epsilon: 0,
      prior: priorWith([["#fast1", 0], ["#fast2", 0], ["#fast3", 0], ["#slow", 500]]),
    });
    const pick = await pickIndex(driver, step({ url: "https://staging.example.test:8443/app?x=1" }));
    expect(pick).toBe(2);
  });

  it("ignores prior actions without a span", async () => {
    const prior = { actions: [{ type: "click", selector: "#slow", success: true, timestamp: 0 } as ActionResult] };
    const driver = perfSeekingDriver({ epsilon: 0, prior });
    const counts = [0, 0, 0, 0];
    const rng = createRng(6);
    for (let i = 0; i < 400; i++) counts[await pickIndex(driver, step({ rng }))]! += 1;
    for (const c of counts) expect(c).toBeGreaterThan(60);
  });

  it("warns once and picks uniformly when an action ran but nothing was measured", async () => {
    const onWarn = vi.fn();
    const driver = perfSeekingDriver({ epsilon: 0, prior: priorWith([["#slow", 900]]), onWarn });
    const rng = createRng(12);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 400; i++) counts[await pickIndex(driver, step({ rng, history: [ran] }))]! += 1;
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toMatch(/perf/);
    // Uniform, prior or not: the prior is not trusted without perf on.
    for (const c of counts) expect(c).toBeGreaterThan(60);
  });

  it("does not warn on a page's first step, which has no previous action", async () => {
    const onWarn = vi.fn();
    const driver = perfSeekingDriver({ onWarn });
    for (let i = 0; i < 5; i++) await driver.selectAction(step());
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("does not take a missing measurement for perf off once one was seen", async () => {
    const onWarn = vi.fn();
    const driver = perfSeekingDriver({ epsilon: 0, onWarn });
    const rng = createRng(13);
    const two = candidates.filter((c) => c.selector === "#fast1" || c.selector === "#slow");
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 2000) }));
    // An unrecorded span later on: still weighted, no warning.
    for (let i = 0; i < 20; i++) expect(await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))).toBe(2);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("resumes weighting when measurements appear after the fallback", async () => {
    const onWarn = vi.fn();
    const driver = perfSeekingDriver({ epsilon: 0, onWarn });
    const rng = createRng(14);
    const two = candidates.filter((c) => c.selector === "#fast1" || c.selector === "#slow");
    await driver.selectAction(step({ rng, history: [ran] }));
    expect(onWarn).toHaveBeenCalledTimes(1);
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#slow", 2000) }));
    for (let i = 0; i < 20; i++) expect(await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))).toBe(2);
    expect(onWarn).toHaveBeenCalledTimes(1);
  });

  it("keys a candidate by the action type its span will carry", async () => {
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(15);
    const mixed: DriverCandidate[] = [
      { index: 0, selector: "#q", description: "q", type: "input", weight: 1 },
      { index: 1, selector: "#go", description: "go", type: "link", weight: 1 },
    ];
    // A link is recorded as a click, an input as an input.
    await driver.selectAction(
      step({ rng, candidates: mixed, history: [ran], lastActionPerf: { ...facts("#q", 0), key: "/app :: input #q" } }),
    );
    await driver.selectAction(
      step({ rng, candidates: mixed, history: [ran], lastActionPerf: { ...facts("#go", 2000), key: "/app :: click #go" } }),
    );
    for (let i = 0; i < 20; i++) expect(await pickIndex(driver, step({ rng, candidates: mixed, history: [ran] }))).toBe(1);
  });

  it("keys candidates by the route the page is on after a click navigated", async () => {
    // The visit is `/app`; a link click took the page to `/other`, where the
    // crawler keys spans by `/other`. The driver must look candidates up by
    // that route too, or what it measured there never matches anything.
    const driver = perfSeekingDriver({ epsilon: 0 });
    const rng = createRng(16);
    const other = "http://localhost:4000/other";
    const two = candidates.filter((c) => c.selector === "#fast1" || c.selector === "#slow");
    const onOther = (o: Partial<DriverStep>) => step({ rng, candidates: two, currentUrl: other, history: [ran], ...o });
    await driver.selectAction(onOther({ lastActionPerf: { ...facts("#fast1", 0), key: "/other :: click #fast1" } }));
    await driver.selectAction(onOther({ lastActionPerf: { ...facts("#slow", 2000), key: "/other :: click #slow" } }));
    let slow = 0;
    for (let i = 0; i < 50; i++) if ((await pickIndex(driver, onOther({}))) === 2) slow += 1;
    expect(slow).toBeGreaterThan(45);
  });

  it("makes the same picks for a seed when costs differ only by timing noise", async () => {
    // Two runs of one crawl: same seed, same screen, and every step costs
    // what it cost in the other run give or take ~1.5ms — the jitter two
    // runs of the same click show. Cheap steps cost 0–3ms, the slow one
    // ~201ms. Weighting by the raw numbers let that jitter move the pick
    // boundaries (a cheap key at 2.3ms weighs 3.3, at 0.4 it weighs 1.4),
    // so near-tied candidates swapped and the runs diverged.
    const base: Record<string, number> = { "#fast1": 1, "#fast2": 1.5, "#slow": 201, "#fast3": 0.5 };
    const run = async (noise: readonly number[]) => {
      const driver = perfSeekingDriver();
      const rng = createRng(21);
      const out: number[] = [];
      let last: LastActionPerf | undefined;
      for (let i = 0; i < 60; i++) {
        const index = await pickIndex(driver, step({ rng, history: i > 0 ? [ran] : [], ...(last ? { lastActionPerf: last } : {}) }));
        out.push(index);
        const sel = candidates[index]!.selector;
        last = facts(sel, Math.max(0, base[sel]! + noise[i % noise.length]!));
      }
      return out;
    };
    const a = await run([0.4, -0.7, 1.2, -0.3, 0.9, -1.0, 0.1]);
    const b = await run([-0.8, 1.3, -0.2, 0.7, -1.1, 0.5, 1.4]);
    expect(b).toEqual(a);
  });

  // B18: two runs of one seed on the same page must pick the same sequence.
  // Each test below replays one crawl twice through a driver, feeding every
  // step the measurement of the action the driver picked the step before,
  // with the two runs' measurements differing only the way two real runs do.
  const replay = async (
    seed: number,
    measure: (selector: string, i: number) => LastActionPerf,
    opts: Parameters<typeof perfSeekingDriver>[0] = {},
    steps = 60,
  ): Promise<number[]> => {
    const driver = perfSeekingDriver(opts);
    const rng = createRng(seed);
    const out: number[] = [];
    let last: LastActionPerf | undefined;
    for (let i = 0; i < steps; i++) {
      const index = await pickIndex(
        driver,
        step({ rng, history: i > 0 ? [ran] : [], ...(last ? { lastActionPerf: last } : {}) }),
      );
      out.push(index);
      last = measure(candidates[index]!.selector, i);
    }
    return out;
  };

  it("makes the same picks when a key's mean lands a few buckets of 5 ms apart (162 vs 177)", async () => {
    // The E7 recheck: the Medium key's mean was 162.4 ms in one run and
    // 177.3 in the other. Linear 5 ms buckets put those three buckets apart,
    // and against a 200 ms key that moves every pick boundary by ~2%.
    const costs = (mid: number, slow: number) => (sel: string) =>
      facts(sel, sel === "#fast1" ? mid : sel === "#slow" ? slow : 0);
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = await replay(seed, costs(162, 200));
      const b = await replay(seed, costs(177, 208));
      expect(b).toEqual(a);
    }
  });

  it("makes the same picks whether or not an interaction arrived before the step read the span", async () => {
    // The root cause of the E7 divergences: `lastActionPerf` is read mid-page,
    // and the browser reports an interaction only after the paint that ends
    // it, so the same 200 ms click read { blocking 200 } in one run and
    // { blocking 200, interaction 208 } in the other. Summed, that is 200 vs
    // 408 for the same key.
    const busy: Record<string, number> = { "#fast1": 80, "#slow": 200 };
    const late = (sel: string) => facts(sel, busy[sel] ?? 0);
    const inTime = (sel: string, i: number) =>
      facts(sel, busy[sel] ?? 0, i % 2 === 0 ? Math.ceil(((busy[sel] ?? 0) + 1) / 8) * 8 : undefined);
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(await replay(seed, inTime)).toEqual(await replay(seed, late));
    }
  });

  it("draws exactly two values from step.rng per step on every branch", async () => {
    const counting = (seed: number) => {
      const inner = createRng(seed);
      const rng: Rng & { draws: number } = { seed, draws: 0, next: () => (rng.draws++, inner.next()) };
      return rng;
    };
    const drawsFor = async (
      driver: ReturnType<typeof perfSeekingDriver>,
      o: Partial<DriverStep>,
    ): Promise<number> => {
      const rng = counting(3);
      await driver.selectAction(step({ ...o, rng }));
      return rng.draws;
    };
    const measureAll = async (driver: ReturnType<typeof perfSeekingDriver>) => {
      for (const c of candidates) {
        await driver.selectAction(step({ history: [ran], lastActionPerf: facts(c.selector, c.selector === "#slow" ? 300 : 0) }));
      }
    };
    // Nothing measured, epsilon 1: the uniform-among-untried branch.
    expect(await drawsFor(perfSeekingDriver({ epsilon: 1 }), {})).toBe(2);
    // Some measured, epsilon 0: weighted with untried candidates beside.
    const partly = perfSeekingDriver({ epsilon: 0 });
    await partly.selectAction(step({ history: [ran], lastActionPerf: facts("#slow", 300) }));
    expect(await drawsFor(partly, { history: [ran] })).toBe(2);
    // Every candidate measured: no untried one, so no exploration to roll for.
    const all = perfSeekingDriver();
    await measureAll(all);
    expect(await drawsFor(all, { history: [ran] })).toBe(2);
    // Perf off: the uniform fallback.
    const off = perfSeekingDriver({ onWarn: () => {} });
    expect(await drawsFor(off, { history: [ran] })).toBe(2);
  });

  it("does not depend on the order measurements arrived in", async () => {
    // Same measurements, two arrival orders. As floats, 14.7 + 0.2 + 0.1 is
    // 14.999999999999998 while 0.1 + 0.2 + 14.7 is 15, so a mean can land on
    // either side of a bucket edge (5 ms before, 63 ms now) by order alone.
    const spans: Array<[string, number]> = [
      ["#fast1", 0.1], ["#fast1", 0.2], ["#fast1", 14.7],
      ["#fast2", 0.1], ["#fast2", 0.2], ["#fast2", 188.7],
      ["#slow", 150], ["#fast3", 0],
    ];
    const picks = async (order: Array<[string, number]>) => {
      const driver = perfSeekingDriver({ epsilon: 0, prior: priorWith(order) });
      const rng = createRng(17);
      const out: number[] = [];
      for (let i = 0; i < 60; i++) out.push(await pickIndex(driver, step({ rng })));
      return out;
    };
    const forward = await picks(spans);
    expect(await picks([...spans].reverse())).toEqual(forward);
    // Interleaved differently again, as live steps would deliver them.
    const shuffled = [spans[7]!, spans[2]!, spans[5]!, spans[0]!, spans[6]!, spans[4]!, spans[1]!, spans[3]!];
    expect(await picks(shuffled)).toEqual(forward);
  });

  it("refuses an epsilon outside [0, 1]", () => {
    expect(() => perfSeekingDriver({ epsilon: 1.5 })).toThrow(/epsilon/);
    expect(() => perfSeekingDriver({ epsilon: Number.NaN })).toThrow(/epsilon/);
  });
});

describe("perfSeekingBucketCost", () => {
  it("weighs every cost under the threshold as nothing", () => {
    for (const ms of [0, 1, 16, 24, 41.9]) expect(perfSeekingBucketCost(ms)).toBe(0);
    expect(perfSeekingBucketCost(Number.NaN)).toBe(0);
    expect(perfSeekingBucketCost(PERF_SEEKING_COST_THRESHOLD_MS)).toBeGreaterThan(0);
  });

  it("puts multiplicative jitter of a slow step into one bucket", () => {
    expect(perfSeekingBucketCost(177.3)).toBe(perfSeekingBucketCost(162.4));
    expect(perfSeekingBucketCost(208)).toBe(perfSeekingBucketCost(200));
    expect(perfSeekingBucketCost(88)).toBe(perfSeekingBucketCost(80));
    expect(perfSeekingBucketCost(1040)).toBe(perfSeekingBucketCost(960));
  });

  it("still ranks costs a bucket apart, so the steering keeps its order", () => {
    const heavy = perfSeekingBucketCost(200);
    const medium = perfSeekingBucketCost(80);
    expect(heavy / medium).toBeGreaterThan(2);
    expect(heavy + PERF_SEEKING_COST_FLOOR_MS).toBeGreaterThan(150 * PERF_SEEKING_COST_FLOOR_MS);
    let prev = 0;
    for (let ms = 0; ms <= 5000; ms += 7) {
      const b = perfSeekingBucketCost(ms);
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(perfSeekingBucketCost(Number.POSITIVE_INFINITY)).toBeGreaterThan(perfSeekingBucketCost(1e9));
  });
});
