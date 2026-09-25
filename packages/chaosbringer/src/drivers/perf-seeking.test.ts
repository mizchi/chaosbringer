import { describe, expect, it, vi } from "vitest";
import { createRng } from "../random.js";
import type { ActionResult, CrawlReport, LastActionPerf } from "../types.js";
import {
  PERF_SEEKING_COST_FLOOR_MS,
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
  it("adds interaction latency to blocking time, and counts a missing interaction as 0", () => {
    expect(perfSeekingCost(facts("#a", 50, 120))).toBe(170);
    expect(perfSeekingCost(facts("#a", 50))).toBe(50);
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
    // One 100ms measurement of #fast1 handed to three attempts of a step,
    // then a 0ms one: counted once, #fast1's mean is 50; counted three
    // times it would be 75. #fast2 at 60 sits between the two.
    const costly = facts("#fast1", 100);
    for (let i = 0; i < 3; i++) await driver.selectAction(step({ rng, history: [ran], lastActionPerf: costly }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast1", 0) }));
    await driver.selectAction(step({ rng, history: [ran], lastActionPerf: facts("#fast2", 60) }));
    const two = candidates.slice(0, 2);
    let fast2 = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if ((await pickIndex(driver, step({ rng, candidates: two, history: [ran] }))) === 1) fast2 += 1;
    }
    // Expected 61/112 = 0.545 counted once, 61/137 = 0.445 counted thrice.
    expect(fast2 / n).toBeGreaterThan(0.5);
  });

  it("weights an unmeasured candidate as the average measured one on the screen", async () => {
    // #slow at 1000 and #fast1 at 0 average 500, so #fast2 and #fast3 weigh
    // 501 each against 1001 and 1: half of the picks go to the two untried.
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

  it("refuses an epsilon outside [0, 1]", () => {
    expect(() => perfSeekingDriver({ epsilon: 1.5 })).toThrow(/epsilon/);
    expect(() => perfSeekingDriver({ epsilon: Number.NaN })).toThrow(/epsilon/);
  });
});
