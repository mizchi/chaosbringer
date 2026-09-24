import { describe, expect, it } from "vitest";
import { createRng } from "./random.js";
import {
  compileLifecycleFaults,
  executeLifecycleAction,
  lifecycleFaultName,
  lifecycleFaultsAtStage,
  lifecycleMatchesUrl,
  lifecycleStatsFrom,
  PlaywrightLifecycleExecutor,
  shouldFireProbability,
  type LifecycleActionExecutor,
} from "./lifecycle-faults.js";
import type { BrowserContext, CDPSession, Page } from "playwright";
import type { LifecycleFault } from "./types.js";

describe("lifecycleFaultName", () => {
  it("uses fault.name when set", () => {
    const f: LifecycleFault = {
      name: "explicit",
      when: "afterLoad",
      action: { kind: "clear-storage", scopes: ["localStorage"] },
    };
    expect(lifecycleFaultName(f)).toBe("explicit");
  });

  it("derives a label per action kind", () => {
    expect(
      lifecycleFaultName({
        when: "beforeNavigation",
        action: { kind: "cpu-throttle", rate: 4 },
      }),
    ).toBe("cpu-throttle:4x");

    expect(
      lifecycleFaultName({
        when: "afterLoad",
        action: { kind: "clear-storage", scopes: ["localStorage", "cookies"] },
      }),
    ).toBe("clear-storage:localStorage+cookies");

    expect(
      lifecycleFaultName({
        when: "beforeActions",
        action: { kind: "evict-cache" },
      }),
    ).toBe("evict-cache");

    expect(
      lifecycleFaultName({
        when: "beforeActions",
        action: { kind: "evict-cache", cacheNames: ["v1"] },
      }),
    ).toBe("evict-cache:v1");

    expect(
      lifecycleFaultName({
        when: "afterLoad",
        action: { kind: "tamper-storage", scope: "localStorage", key: "auth", value: "" },
      }),
    ).toBe("tamper-storage:localStorage.auth");
  });
});

describe("compileLifecycleFaults", () => {
  it("returns [] for undefined / empty", () => {
    expect(compileLifecycleFaults(undefined)).toEqual([]);
    expect(compileLifecycleFaults([])).toEqual([]);
  });

  it("compiles regex patterns from string and RegExp matchers", () => {
    const c = compileLifecycleFaults([
      {
        when: "afterLoad",
        urlPattern: "/dashboard",
        action: { kind: "clear-storage", scopes: ["localStorage"] },
      },
      {
        when: "afterLoad",
        urlPattern: /\/api\//,
        action: { kind: "clear-storage", scopes: ["localStorage"] },
      },
    ]);
    expect(c[0]!.pattern).toBeInstanceOf(RegExp);
    expect(c[0]!.pattern!.test("/dashboard/home")).toBe(true);
    expect(c[1]!.pattern).toBeInstanceOf(RegExp);
    expect(c[1]!.pattern!.test("/api/x")).toBe(true);
  });

  it("leaves pattern null when urlPattern is omitted", () => {
    const c = compileLifecycleFaults([
      {
        when: "afterLoad",
        action: { kind: "clear-storage", scopes: ["localStorage"] },
      },
    ]);
    expect(c[0]!.pattern).toBeNull();
  });

  it("derives the name from the action when not provided", () => {
    const c = compileLifecycleFaults([
      { when: "beforeNavigation", action: { kind: "cpu-throttle", rate: 8 } },
    ]);
    expect(c[0]!.name).toBe("cpu-throttle:8x");
  });
});

describe("lifecycleMatchesUrl", () => {
  it("matches every URL when pattern is null", () => {
    expect(lifecycleMatchesUrl({ pattern: null }, "anything")).toBe(true);
  });

  it("delegates to the compiled regex when present", () => {
    expect(lifecycleMatchesUrl({ pattern: /^\/api\// }, "/api/x")).toBe(true);
    expect(lifecycleMatchesUrl({ pattern: /^\/api\// }, "/static/x")).toBe(false);
  });
});

describe("shouldFireProbability", () => {
  it("treats undefined / >=1 as always-fire and never consumes the RNG", () => {
    let calls = 0;
    const rng = {
      next() {
        calls++;
        return 0.5;
      },
    };
    expect(shouldFireProbability(undefined, rng)).toBe(true);
    expect(shouldFireProbability(1, rng)).toBe(true);
    expect(shouldFireProbability(2, rng)).toBe(true);
    expect(calls).toBe(0);
  });

  it("treats <=0 as never-fire and never consumes the RNG", () => {
    let calls = 0;
    const rng = {
      next() {
        calls++;
        return 0.5;
      },
    };
    expect(shouldFireProbability(0, rng)).toBe(false);
    expect(shouldFireProbability(-1, rng)).toBe(false);
    expect(calls).toBe(0);
  });

  it("samples one number from the RNG when prob is in (0, 1)", () => {
    // mulberry32 seed 1 → first next() ≈ 0.62707
    const rng1 = createRng(1);
    expect(shouldFireProbability(0.7, rng1)).toBe(true); // 0.627 < 0.7
    const rng2 = createRng(1);
    expect(shouldFireProbability(0.5, rng2)).toBe(false); // 0.627 >= 0.5
  });

  it("consumes exactly one RNG draw when prob is in (0, 1)", () => {
    let calls = 0;
    const rng = {
      next() {
        calls++;
        return 0.5;
      },
    };
    shouldFireProbability(0.6, rng);
    expect(calls).toBe(1);
  });
});

describe("lifecycleFaultsAtStage", () => {
  it("filters by `when`", () => {
    const compiled = compileLifecycleFaults([
      { when: "beforeNavigation", action: { kind: "cpu-throttle", rate: 2 } },
      {
        when: "afterLoad",
        action: { kind: "clear-storage", scopes: ["localStorage"] },
      },
      { when: "beforeActions", action: { kind: "evict-cache" } },
    ]);
    expect(lifecycleFaultsAtStage(compiled, "afterLoad").map((c) => c.name)).toEqual([
      "clear-storage:localStorage",
    ]);
    expect(lifecycleFaultsAtStage(compiled, "betweenActions")).toEqual([]);
  });
});

describe("lifecycleStatsFrom", () => {
  it("projects matched / fired / errored counters", () => {
    const compiled = compileLifecycleFaults([
      { when: "beforeNavigation", action: { kind: "cpu-throttle", rate: 2 } },
    ]);
    compiled[0]!.matched = 5;
    compiled[0]!.fired = 3;
    compiled[0]!.errored = 1;
    expect(lifecycleStatsFrom(compiled)).toEqual([
      { name: "cpu-throttle:2x", matched: 5, fired: 3, errored: 1 },
    ]);
  });
});

describe("executeLifecycleAction", () => {
  function makeFakeExecutor() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const exec: LifecycleActionExecutor = {
      async cpuThrottle(rate) {
        calls.push({ method: "cpuThrottle", args: [rate] });
      },
      async clearStorage(scopes) {
        calls.push({ method: "clearStorage", args: [Array.from(scopes)] });
      },
      async evictCache(cacheNames) {
        calls.push({ method: "evictCache", args: [cacheNames ? Array.from(cacheNames) : undefined] });
      },
      async tamperStorage(scope, key, value) {
        calls.push({ method: "tamperStorage", args: [scope, key, value] });
      },
    };
    return { exec, calls };
  }

  it("dispatches cpu-throttle to cpuThrottle", async () => {
    const { exec, calls } = makeFakeExecutor();
    await executeLifecycleAction({ kind: "cpu-throttle", rate: 4 }, exec);
    expect(calls).toEqual([{ method: "cpuThrottle", args: [4] }]);
  });

  it("dispatches clear-storage to clearStorage", async () => {
    const { exec, calls } = makeFakeExecutor();
    await executeLifecycleAction(
      { kind: "clear-storage", scopes: ["localStorage", "cookies"] },
      exec,
    );
    expect(calls).toEqual([{ method: "clearStorage", args: [["localStorage", "cookies"]] }]);
  });

  it("dispatches evict-cache to evictCache (with and without names)", async () => {
    const { exec, calls } = makeFakeExecutor();
    await executeLifecycleAction({ kind: "evict-cache" }, exec);
    await executeLifecycleAction({ kind: "evict-cache", cacheNames: ["v1"] }, exec);
    expect(calls).toEqual([
      { method: "evictCache", args: [undefined] },
      { method: "evictCache", args: [["v1"]] },
    ]);
  });

  it("dispatches tamper-storage to tamperStorage", async () => {
    const { exec, calls } = makeFakeExecutor();
    await executeLifecycleAction(
      { kind: "tamper-storage", scope: "sessionStorage", key: "auth", value: "expired" },
      exec,
    );
    expect(calls).toEqual([
      { method: "tamperStorage", args: ["sessionStorage", "auth", "expired"] },
    ]);
  });
});

describe("PlaywrightLifecycleExecutor CDP session", () => {
  function fakeSession(log: string[]): CDPSession {
    return {
      send: async (method: string, params?: unknown) => {
        log.push(`${method} ${JSON.stringify(params)}`);
        return {};
      },
    } as unknown as CDPSession;
  }

  it("uses an injected session provider instead of attaching its own, once", async () => {
    const sent: string[] = [];
    let attached = 0;
    let provided = 0;
    const context = {
      newCDPSession: async () => {
        attached++;
        return fakeSession(sent);
      },
    } as unknown as BrowserContext;
    const executor = new PlaywrightLifecycleExecutor({} as Page, context, async () => {
      provided++;
      return fakeSession(sent);
    });
    await executor.cpuThrottle(4);
    await executor.cpuThrottle(1);
    expect(attached).toBe(0);
    expect(provided).toBe(1);
    expect(sent).toEqual([
      'Emulation.setCPUThrottlingRate {"rate":4}',
      'Emulation.setCPUThrottlingRate {"rate":1}',
    ]);
  });

  it("attaches its own session lazily when none is injected", async () => {
    const sent: string[] = [];
    const pages: unknown[] = [];
    const page = {} as Page;
    const context = {
      newCDPSession: async (p: Page) => {
        pages.push(p);
        return fakeSession(sent);
      },
    } as unknown as BrowserContext;
    const executor = new PlaywrightLifecycleExecutor(page, context);
    expect(pages).toHaveLength(0);
    await executor.cpuThrottle(2);
    await executor.cpuThrottle(3);
    expect(pages).toEqual([page]);
    expect(sent).toHaveLength(2);
  });
});
