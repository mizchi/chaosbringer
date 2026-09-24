import { describe, expect, it } from "vitest";
import {
  decideSettle,
  parseSettleArg,
  RequestTracker,
  resolveSettle,
  settleAdaptive,
  settleReproArg,
  validateSettle,
  type SettleEnv,
  type SettleProbe,
} from "./settle.js";
import { buildReproCommand } from "./repro-command.js";
import { DEFAULT_OPTIONS } from "./defaults.js";
import type { CrawlerOptions } from "./types.js";

/**
 * A page on a fake clock. Network events and long tasks are scheduled at
 * absolute times; `wait` advances the clock and, like the real tracker,
 * returns early on the first network event. A probe costs one frame per
 * requested frame (16 ms) or 1 ms, and cannot answer while a long task runs.
 */
function fakePage() {
  let t = 0;
  const tracker = new RequestTracker(() => t);
  const events: { at: number; run: () => void }[] = [];
  const longTasks: { start: number; end: number }[] = [];
  const probes: number[] = [];
  let navigateAt: number | null = null;

  const runDue = (until: number): boolean => {
    let fired = false;
    events.sort((a, b) => a.at - b.at);
    while (events.length > 0 && events[0]!.at <= until) {
      const e = events.shift()!;
      t = Math.max(t, e.at);
      e.run();
      fired = true;
    }
    return fired;
  };

  const env: SettleEnv = {
    now: () => t,
    async wait(ms) {
      const until = t + ms;
      const next = events.sort((a, b) => a.at - b.at)[0];
      if (next && next.at <= until) {
        runDue(next.at);
        return;
      }
      t = until;
    },
    async probe(frames, timeoutMs): Promise<SettleProbe> {
      probes.push(t);
      const deadline = t + timeoutMs;
      // A running long task holds the probe until it ends.
      const busy = longTasks.find((lt) => lt.start <= t && t < lt.end);
      if (busy) {
        if (busy.end > deadline) {
          t = deadline;
          return { kind: "timeout" };
        }
        t = busy.end;
      }
      if (navigateAt !== null && navigateAt <= t + 32) {
        t = navigateAt;
        navigateAt = null;
        return { kind: "navigated" };
      }
      t += frames ? 32 : 1;
      runDue(t);
      const ended = longTasks.filter((lt) => lt.end <= t);
      if (ended.length === 0) return { kind: "ok", longTaskAgeMs: null };
      return { kind: "ok", longTaskAgeMs: t - Math.max(...ended.map((lt) => lt.end)) };
    },
  };

  return {
    tracker,
    env,
    probes,
    now: () => t,
    request(id: string, start: number, end: number | null) {
      events.push({ at: start, run: () => tracker.started(id) });
      if (end !== null) events.push({ at: end, run: () => tracker.ended(id) });
    },
    longTask(start: number, duration: number) {
      longTasks.push({ start, end: start + duration });
    },
    navigate(at: number) {
      navigateAt = at;
    },
    advance(ms: number) {
      t += ms;
      runDue(t);
    },
  };
}

describe("settleAdaptive", () => {
  it("settles after two frames on a page that has been quiet for the window", async () => {
    const p = fakePage();
    p.advance(1000);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out).toEqual({ capped: false, elapsedMs: 32 });
  });

  it("waits for a request in flight, then the quiet window after it", async () => {
    const p = fakePage();
    p.request("xhr", 0, 300);
    p.advance(0);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out.capped).toBe(false);
    // Not before the request ended plus the quiet window, and not much after.
    expect(out.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(out.elapsedMs).toBeLessThan(410);
  });

  it("restarts the window on every new request", async () => {
    const p = fakePage();
    p.request("a", 0, 50);
    p.request("b", 120, 170); // inside a's quiet window
    p.request("c", 250, 260); // inside b's
    p.advance(0);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out.capped).toBe(false);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(360);
    expect(out.elapsedMs).toBeLessThan(370);
  });

  it("restarts the window on a long task", async () => {
    const p = fakePage();
    p.request("xhr", 0, 50);
    // Without it the step settles at 150; the task ends at 160, inside the
    // window, so the window restarts from there.
    p.longTask(100, 60);
    p.advance(0);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out.capped).toBe(false);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(260);
    expect(out.elapsedMs).toBeLessThan(270);
  });

  it("caps on a request that never ends, and says why", async () => {
    const p = fakePage();
    p.request("hung", 0, null);
    p.advance(0);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out).toEqual({ capped: true, reason: "inflight", elapsedMs: 2000 });
  });

  it("does not hold a later settle on a request that already outlived the cap", async () => {
    const p = fakePage();
    p.request("hung", 0, null);
    p.advance(0);
    expect((await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 })).capped).toBe(true);
    // The next step: the hung request is older than the cap, so it no longer
    // counts — one hung request caps one step, not the rest of the page.
    const next = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(next.capped).toBe(false);
  });

  it("caps on a hung request that started before the settle began", async () => {
    // The load settle: the request starts during `goto`, the settle begins
    // at `load` with the rest of the timeout as its cap. Aged from its own
    // start, the request would drop out 250 ms before the cap and the settle
    // would report itself settled after waiting nearly the whole cap.
    const p = fakePage();
    p.request("hung", 50, null);
    p.advance(50);
    p.advance(250);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 29_700 });
    expect(out).toEqual({ capped: true, reason: "inflight", elapsedMs: 29_700 });
  });

  it("caps when the main thread never answers", async () => {
    const p = fakePage();
    p.advance(1000);
    p.longTask(1000, 10_000);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out).toEqual({ capped: true, reason: "busy", elapsedMs: 2000 });
  });

  it("caps on a page that keeps issuing requests (polling)", async () => {
    const p = fakePage();
    for (let at = 0; at < 3000; at += 80) p.request(`poll-${at}`, at, at + 10);
    p.advance(0);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out.capped).toBe(true);
    expect(out.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(out.elapsedMs).toBeLessThan(2100);
  });

  it("waits for the new document's frames after a navigation", async () => {
    const p = fakePage();
    p.advance(1000);
    p.navigate(1010);
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 2000 });
    expect(out.capped).toBe(false);
    // The swap is activity: settled no earlier than a full window after it.
    expect(p.now()).toBeGreaterThanOrEqual(1110);
    // Probed again with frames after the navigation.
    expect(p.probes.length).toBeGreaterThanOrEqual(2);
  });

  it("a zero cap returns capped at once without probing", async () => {
    const p = fakePage();
    const out = await settleAdaptive(p.tracker, p.env, { quietMs: 100, capMs: 0 });
    expect(out).toEqual({ capped: true, reason: "frames", elapsedMs: 0 });
    expect(p.probes).toEqual([]);
  });

  it("a closed page ends the settle uncapped", async () => {
    const tracker = new RequestTracker(() => 0);
    const env: SettleEnv = {
      now: () => 0,
      wait: async () => {},
      probe: async () => ({ kind: "gone" }),
    };
    expect(await settleAdaptive(tracker, env, { quietMs: 100, capMs: 2000 })).toEqual({
      capped: false,
      elapsedMs: 0,
    });
  });
});

describe("decideSettle", () => {
  const base = {
    now: 1000,
    capAt: 3000,
    quietMs: 100,
    inflight: 0,
    lastNetworkActivity: 850,
    lastLongTaskEnd: Number.NEGATIVE_INFINITY,
    framesDone: true,
  };
  it("settled once every condition holds", () => {
    expect(decideSettle(base)).toEqual({ kind: "settled" });
  });
  it("waits out the rest of the window", () => {
    expect(decideSettle({ ...base, lastNetworkActivity: 950 })).toEqual({ kind: "wait", ms: 50 });
    expect(decideSettle({ ...base, lastLongTaskEnd: 960 })).toEqual({ kind: "wait", ms: 60 });
  });
  it("never settles with a request in flight or frames outstanding", () => {
    expect(decideSettle({ ...base, inflight: 1 }).kind).toBe("wait");
    expect(decideSettle({ ...base, framesDone: false }).kind).toBe("wait");
  });
  it("caps at capAt with the reason", () => {
    expect(decideSettle({ ...base, now: 3000, inflight: 1 })).toEqual({ kind: "capped", reason: "inflight" });
    expect(decideSettle({ ...base, now: 3000, lastLongTaskEnd: 2990 })).toEqual({
      kind: "capped",
      reason: "long-task",
    });
    expect(decideSettle({ ...base, now: 3000, framesDone: false })).toEqual({
      kind: "capped",
      reason: "frames",
    });
  });
  it("never waits past the cap", () => {
    expect(decideSettle({ ...base, now: 2990, lastNetworkActivity: 2980 })).toEqual({ kind: "wait", ms: 10 });
  });
});

describe("RequestTracker", () => {
  it("wakes a waiter on network activity", async () => {
    const tracker = new RequestTracker(() => 0);
    const start = Date.now();
    const waiting = tracker.wait(10_000);
    tracker.started("r");
    await waiting;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(tracker.inflight(0, 2000).count).toBe(1);
    tracker.ended("r");
    expect(tracker.inflight(0, 2000).count).toBe(0);
  });
  it("counts an aged-out request as activity at the moment it aged out", () => {
    let t = 0;
    const tracker = new RequestTracker(() => t);
    tracker.started("r");
    t = 5000;
    expect(tracker.inflight(5000, 2000)).toEqual({ count: 0, lastActivity: 2000 });
  });
});

describe("settle option", () => {
  it("resolves the modes", () => {
    expect(resolveSettle(undefined)).toEqual({ mode: "networkidle" });
    expect(resolveSettle("networkidle")).toEqual({ mode: "networkidle" });
    expect(resolveSettle("adaptive")).toEqual({ mode: "adaptive", quietMs: 100 });
    expect(resolveSettle(250)).toEqual({ mode: "adaptive", quietMs: 250 });
  });
  it("validates", () => {
    for (const ok of [undefined, "networkidle", "adaptive", 0, 100, 1999]) {
      expect(() => validateSettle(ok)).not.toThrow();
    }
    expect(() => validateSettle("idle")).toThrow(/"settle" must be "networkidle", "adaptive"/);
    expect(() => validateSettle(2000)).toThrow(/integer in \[0, 2000\)/);
    expect(() => validateSettle(-1)).toThrow(/integer in \[0, 2000\)/);
    expect(() => validateSettle(1.5)).toThrow(/integer in \[0, 2000\)/);
    expect(() => validateSettle(Number.NaN)).toThrow(/integer in \[0, 2000\)/);
  });
  it("parses --settle", () => {
    expect(parseSettleArg("adaptive")).toBe("adaptive");
    expect(parseSettleArg("networkidle")).toBe("networkidle");
    expect(parseSettleArg("150")).toBe(150);
    expect(() => parseSettleArg("")).toThrow(/--settle must be/);
    expect(() => parseSettleArg("fast")).toThrow(/--settle must be/);
    expect(() => parseSettleArg("5000")).toThrow(/integer in \[0, 2000\)/);
  });
  it("round-trips through the repro command, and the default adds nothing", () => {
    expect(settleReproArg(undefined)).toBeNull();
    expect(settleReproArg("networkidle")).toBeNull();
    const opts = (settle: CrawlerOptions["settle"]) =>
      ({ ...DEFAULT_OPTIONS, baseUrl: "http://x.test", settle }) as Required<CrawlerOptions>;
    expect(buildReproCommand(opts("networkidle"), 1)).not.toContain("--settle");
    expect(buildReproCommand(opts("adaptive"), 1)).toContain("--settle adaptive");
    expect(buildReproCommand(opts(150), 1)).toContain("--settle 150");
  });
});
