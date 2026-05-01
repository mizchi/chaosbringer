import { describe, expect, it } from "vitest";
import { createRng } from "./random.js";
import {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
  runtimeFaultName,
  runtimeMatchesUrl,
  shouldFireProbability,
} from "./runtime-faults.js";
import type { RuntimeFault } from "./types.js";

describe("runtimeFaultName", () => {
  it("uses an explicit name when set", () => {
    expect(
      runtimeFaultName({ name: "custom", action: { kind: "flaky-fetch" } }),
    ).toBe("custom");
  });

  it("auto-derives a name for flaky-fetch", () => {
    expect(runtimeFaultName({ action: { kind: "flaky-fetch" } })).toBe("flaky-fetch");
  });

  it("auto-derives a name for clock-skew including the skew amount", () => {
    expect(
      runtimeFaultName({ action: { kind: "clock-skew", skewMs: 60_000 } }),
    ).toBe("clock-skew:60000ms");
  });
});

describe("compileRuntimeFaults", () => {
  it("returns empty array for empty input", () => {
    expect(compileRuntimeFaults(undefined)).toEqual([]);
    expect(compileRuntimeFaults([])).toEqual([]);
  });

  it("compiles string urlPattern to RegExp", () => {
    const compiled = compileRuntimeFaults([
      { urlPattern: "api", action: { kind: "flaky-fetch" } },
    ]);
    expect(compiled[0]!.pattern).toBeInstanceOf(RegExp);
    expect(compiled[0]!.pattern!.test("http://x/api/users")).toBe(true);
  });

  it("preserves RegExp urlPattern verbatim", () => {
    const re = /\/api\//i;
    const compiled = compileRuntimeFaults([{ urlPattern: re, action: { kind: "flaky-fetch" } }]);
    expect(compiled[0]!.pattern).toBe(re);
  });

  it("leaves pattern null when urlPattern is omitted", () => {
    const compiled = compileRuntimeFaults([{ action: { kind: "flaky-fetch" } }]);
    expect(compiled[0]!.pattern).toBeNull();
  });

  it("seeds counters at zero", () => {
    const compiled = compileRuntimeFaults([{ action: { kind: "flaky-fetch" } }]);
    expect(compiled[0]!.matched).toBe(0);
    expect(compiled[0]!.fired).toBe(0);
  });
});

describe("runtimeMatchesUrl", () => {
  it("matches everything when pattern is null", () => {
    expect(runtimeMatchesUrl({ pattern: null }, "http://x/")).toBe(true);
  });

  it("matches via the regex", () => {
    expect(runtimeMatchesUrl({ pattern: /\/api\// }, "http://x/api/users")).toBe(true);
    expect(runtimeMatchesUrl({ pattern: /\/api\// }, "http://x/static/foo")).toBe(false);
  });
});

describe("shouldFireProbability", () => {
  it("always fires when probability is undefined or >= 1", () => {
    const rng = createRng(1);
    expect(shouldFireProbability(undefined, rng)).toBe(true);
    expect(shouldFireProbability(1, rng)).toBe(true);
    expect(shouldFireProbability(2, rng)).toBe(true);
  });

  it("never fires when probability is 0 or negative", () => {
    const rng = createRng(1);
    expect(shouldFireProbability(0, rng)).toBe(false);
    expect(shouldFireProbability(-1, rng)).toBe(false);
  });

  it("rolls deterministically against the RNG", () => {
    const a = createRng(42);
    const b = createRng(42);
    const aFires: boolean[] = [];
    const bFires: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      aFires.push(shouldFireProbability(0.5, a));
      bFires.push(shouldFireProbability(0.5, b));
    }
    expect(aFires).toEqual(bFires);
  });
});

describe("buildRuntimeFaultsScript", () => {
  it("returns a string starting with an IIFE", () => {
    const s = buildRuntimeFaultsScript(
      [{ action: { kind: "flaky-fetch" } }],
      42,
    );
    expect(s.startsWith("(() => {")).toBe(true);
    expect(s).toContain("__chaosbringerRuntimeFaultsInstalled");
    expect(s).toContain("__chaosbringerRuntimeStats");
  });

  it("guards against re-installation", () => {
    const s = buildRuntimeFaultsScript([{ action: { kind: "flaky-fetch" } }], 42);
    expect(s).toContain("if (window.__chaosbringerRuntimeFaultsInstalled) return");
  });

  it("inlines the seed verbatim", () => {
    const s = buildRuntimeFaultsScript([{ action: { kind: "flaky-fetch" } }], 12345);
    expect(s).toContain("12345");
  });

  it("serializes RegExp urlPattern as { source, flags }", () => {
    const s = buildRuntimeFaultsScript(
      [{ urlPattern: /\/api\//i, action: { kind: "flaky-fetch" } }],
      1,
    );
    expect(s).toContain('"source":"\\\\/api\\\\/"');
    expect(s).toContain('"flags":"i"');
  });

  it("serializes string urlPattern with empty flags", () => {
    const s = buildRuntimeFaultsScript(
      [{ urlPattern: "/api/", action: { kind: "flaky-fetch" } }],
      1,
    );
    expect(s).toContain('"source":"/api/"');
    expect(s).toContain('"flags":""');
  });

  it("includes the fetch patch only when a flaky-fetch fault is present", () => {
    const withFetch = buildRuntimeFaultsScript(
      [{ action: { kind: "flaky-fetch" } }],
      1,
    );
    expect(withFetch).toContain("flaky-fetch");
    expect(withFetch).toContain("Promise.reject");
  });

  it("includes the clock-skew patch only when a clock-skew fault is present", () => {
    const skewed = buildRuntimeFaultsScript(
      [{ action: { kind: "clock-skew", skewMs: 5000 } }],
      1,
    );
    expect(skewed).toContain("clock-skew");
    expect(skewed).toContain("performance.now");
    expect(skewed).toContain("Date.now");
  });

  it("uses the fault's auto-derived name as a display label", () => {
    const s = buildRuntimeFaultsScript(
      [{ action: { kind: "flaky-fetch" } }, { action: { kind: "clock-skew", skewMs: 1000 } }],
      1,
    );
    expect(s).toContain('"name":"flaky-fetch"');
    expect(s).toContain('"name":"clock-skew:1000ms"');
  });

  it("assigns sequential id keys so duplicate names don't collide in stats", () => {
    const s = buildRuntimeFaultsScript(
      [{ action: { kind: "flaky-fetch" } }, { action: { kind: "flaky-fetch" } }],
      1,
    );
    expect(s).toContain('"id":0');
    expect(s).toContain('"id":1');
    // The stats accessor uses String(f.id), not f.name.
    expect(s).toContain("stats[String(f.id)]");
  });

  it("does not 32-bit-truncate large skewMs values", () => {
    // 30 days = 2,592,000,000 ms — exceeds int32 max. The script must
    // accumulate via Number(...), not `| 0`.
    const s = buildRuntimeFaultsScript(
      [{ action: { kind: "clock-skew", skewMs: 2_592_000_000 } }],
      1,
    );
    expect(s).not.toContain("skewMs | 0");
    expect(s).toContain("Number(f.action.skewMs)");
  });

  it("respects an explicit fault name", () => {
    const s = buildRuntimeFaultsScript(
      [{ name: "spy", action: { kind: "flaky-fetch" } }],
      1,
    );
    expect(s).toContain('"name":"spy"');
  });

  it("is a no-op when no faults are configured (still emits the IIFE shell)", () => {
    const s = buildRuntimeFaultsScript([], 1);
    expect(s.startsWith("(() => {")).toBe(true);
    expect(s).toContain("__chaosbringerRuntimeFaultsInstalled");
  });

  it("accepts negative seed by coercing into an unsigned 32-bit", () => {
    const s = buildRuntimeFaultsScript([{ action: { kind: "flaky-fetch" } }], -1);
    // -1 coerced to uint32 is 4294967295.
    expect(s).toContain("4294967295");
  });
});

describe("mergeRuntimeStats", () => {
  it("accumulates per-page counters by index into the compiled fault counters", () => {
    const compiled = compileRuntimeFaults([
      { name: "f1", action: { kind: "flaky-fetch" } },
      { name: "c1", action: { kind: "clock-skew", skewMs: 100 } },
    ]);
    mergeRuntimeStats(compiled, { "0": { matched: 3, fired: 2 } });
    expect(compiled[0]!.matched).toBe(3);
    expect(compiled[0]!.fired).toBe(2);
    expect(compiled[1]!.matched).toBe(0);
    expect(compiled[1]!.fired).toBe(0);
    mergeRuntimeStats(compiled, { "0": { matched: 1, fired: 1 } });
    expect(compiled[0]!.matched).toBe(4);
    expect(compiled[0]!.fired).toBe(3);
  });

  it("does not collapse counters when two faults share a name", () => {
    // Both default to name="flaky-fetch"; index keys keep them apart.
    const compiled = compileRuntimeFaults([
      { action: { kind: "flaky-fetch" }, urlPattern: /\/api\/a/ },
      { action: { kind: "flaky-fetch" }, urlPattern: /\/api\/b/ },
    ]);
    mergeRuntimeStats(compiled, {
      "0": { matched: 5, fired: 5 },
      "1": { matched: 1, fired: 0 },
    });
    expect(compiled[0]!.matched).toBe(5);
    expect(compiled[0]!.fired).toBe(5);
    expect(compiled[1]!.matched).toBe(1);
    expect(compiled[1]!.fired).toBe(0);
  });

  it("ignores stats keys that don't correspond to a compiled fault", () => {
    const compiled = compileRuntimeFaults([{ name: "known", action: { kind: "flaky-fetch" } }]);
    mergeRuntimeStats(compiled, { "99": { matched: 99, fired: 99 } });
    expect(compiled[0]!.matched).toBe(0);
  });

  it("returns a stats array shaped like RuntimeFaultStats", () => {
    const compiled = compileRuntimeFaults([{ name: "f", action: { kind: "flaky-fetch" } }]);
    const out = mergeRuntimeStats(compiled, { "0": { matched: 5, fired: 3 } });
    expect(out).toEqual([{ rule: "f", matched: 5, fired: 3 }]);
  });

  it("falls back to a name-keyed snapshot for the first matching fault", () => {
    // Backwards-compat path: when reading legacy snapshots that keyed
    // by name, the merge applies the count to the first compiled fault
    // with that name and skips the rest.
    const compiled = compileRuntimeFaults([
      { name: "shared", action: { kind: "flaky-fetch" } },
      { name: "shared", action: { kind: "flaky-fetch" } },
    ]);
    mergeRuntimeStats(compiled, { shared: { matched: 4, fired: 2 } });
    expect(compiled[0]!.matched).toBe(4);
    expect(compiled[0]!.fired).toBe(2);
    expect(compiled[1]!.matched).toBe(0);
    expect(compiled[1]!.fired).toBe(0);
  });
});

describe("faults.flakyFetch / faults.clockSkew round-trip via compile", () => {
  it("compiles a programmatic fault config without errors", () => {
    const faults: RuntimeFault[] = [
      { action: { kind: "flaky-fetch", rejectionMessage: "oops" }, probability: 0.5 },
      { action: { kind: "clock-skew", skewMs: 30_000 } },
    ];
    const compiled = compileRuntimeFaults(faults);
    expect(compiled).toHaveLength(2);
    expect(compiled[0]!.name).toBe("flaky-fetch");
    expect(compiled[1]!.name).toBe("clock-skew:30000ms");
  });
});
