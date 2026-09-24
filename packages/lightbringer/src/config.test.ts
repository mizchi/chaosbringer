import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionOptionsFromEnv } from "./config";
import { DEFAULT_SETTLE_TIMEOUT_MS, NET_PROFILES, netProfileByName } from "./defaults";

describe("sessionOptionsFromEnv", () => {
  it("defaults with an empty env", () => {
    const o = sessionOptionsFromEnv({});
    expect(o).toEqual({
      outDir: path.resolve("perf-results"),
      cpuRate: 1,
      netProfile: null,
      cssStats: false,
      trace: false,
      coverage: false,
      memGc: false,
      settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
      assert: false,
    });
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBe(5000);
  });

  it("maps every PERF_* knob", () => {
    const o = sessionOptionsFromEnv({
      PERF_OUT_DIR: "/tmp/lb-out",
      PERF_CPU: "4",
      PERF_NET: "fast-3g",
      PERF_TRACE: "1",
      PERF_COV: "1",
      PERF_MEM: "1",
      PERF_SETTLE_TIMEOUT: "1234",
      PERF_ASSERT: "1",
    });
    expect(o.outDir).toBe("/tmp/lb-out");
    expect(o.cpuRate).toBe(4);
    expect(o.netProfile).toEqual(NET_PROFILES["fast-3g"]);
    expect(o.trace).toBe(true);
    expect(o.cssStats).toBe(false);
    expect(o.coverage).toBe(true);
    expect(o.memGc).toBe(true);
    expect(o.settleTimeoutMs).toBe(1234);
    expect(o.assert).toBe(true);
  });

  it("PERF_CSS implies a trace", () => {
    const o = sessionOptionsFromEnv({ PERF_CSS: "1" });
    expect(o.cssStats).toBe(true);
    expect(o.trace).toBe(true);
  });

  it("only exactly '1' enables a flag", () => {
    const o = sessionOptionsFromEnv({ PERF_TRACE: "true", PERF_MEM: "0" });
    expect(o.trace).toBe(false);
    expect(o.memGc).toBe(false);
  });

  it("is pure: reads only the env it is given", () => {
    const before = { ...process.env };
    process.env.PERF_CPU = "9";
    try {
      expect(sessionOptionsFromEnv({}).cpuRate).toBe(1);
      expect(sessionOptionsFromEnv().cpuRate).toBe(9);
    } finally {
      if (before.PERF_CPU === undefined) delete process.env.PERF_CPU;
      else process.env.PERF_CPU = before.PERF_CPU;
    }
  });
});

describe("netProfileByName", () => {
  it("resolves presets and rejects unknown / prototype keys", () => {
    expect(netProfileByName("4g")).toEqual(NET_PROFILES["4g"]);
    expect(netProfileByName("5g")).toBeNull();
    expect(netProfileByName("toString")).toBeNull();
    expect(netProfileByName(undefined)).toBeNull();
    expect(netProfileByName("")).toBeNull();
  });
});
