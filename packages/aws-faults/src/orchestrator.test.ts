import { describe, expect, it } from "vitest";
import { runDrill } from "./orchestrator.ts";
import type { Drill, HealthCheckResult } from "./orchestrator.ts";
import type { KumoChaos } from "./client.ts";
import type { Rule } from "./types.ts";

function mockChaos(): KumoChaos & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async upsertRule(r: Rule) {
      log.push(`upsert:${r.id}`);
    },
    async deleteRule(id: string) {
      log.push(`delete:${id}`);
    },
    async clearRules() {
      log.push("clear");
    },
    async installProfile(rules: Rule[]) {
      log.push(`install:[${rules.map((r) => r.id).join(",")}]`);
    },
    async listRules() {
      return { rules: [], stats: [] };
    },
    async stats() {
      return [];
    },
  };
}

function makeDrill(probe: () => HealthCheckResult, overrides: Partial<Drill> = {}): Drill {
  return {
    id: "test",
    name: "test",
    description: "",
    healthCheck: async () => probe(),
    acceptance: { errorRate: 0, consecutiveGreen: 2 },
    ...overrides,
  };
}

describe("runDrill", () => {
  it("plays phases in order, installing each phase's rules", async () => {
    const chaos = mockChaos();
    const seen: { phase: string; ok: boolean }[] = [];

    const drill = makeDrill(() => ({ ok: true, latencyMs: 10, errorRate: 0 }), {
      phases: [
        {
          label: "onset",
          durationMs: 50,
          rules: [
            { id: "r-onset", enabled: true, match: { service: "s3" }, inject: { kind: "awsError", probability: 1, awsError: { code: "X" } } },
          ],
        },
        {
          label: "peak",
          durationMs: 50,
          rules: [
            { id: "r-peak", enabled: true, match: { service: "s3" }, inject: { kind: "awsError", probability: 1, awsError: { code: "Y" } } },
          ],
        },
      ],
    });

    const report = await runDrill({
      chaos,
      drill,
      baselineMs: 50,
      intervalMs: 10,
      recoveryTimeoutMs: 100,
      onSample: (phase) => seen.push({ phase, ok: true }),
    });

    // Two installs (one per phase) + final clear.
    expect(chaos.log).toEqual(["install:[r-onset]", "install:[r-peak]", "clear"]);
    // Both phases produced samples in injectedByPhase.
    expect(report.injectedByPhase.map((p) => p.label)).toEqual(["onset", "peak"]);
    expect(report.injectedByPhase.every((p) => p.samples.length > 0)).toBe(true);
    // We at least saw both phase labels in sample stream.
    expect(seen.some((s) => s.phase === "onset")).toBe(true);
    expect(seen.some((s) => s.phase === "peak")).toBe(true);
  });

  it("simple-mode drill wraps rules in a single 'injected' phase", async () => {
    const chaos = mockChaos();
    const drill = makeDrill(() => ({ ok: true, latencyMs: 5, errorRate: 0 }), {
      rules: [
        { id: "r1", enabled: true, match: { service: "s3" }, inject: { kind: "awsError", probability: 1, awsError: { code: "X" } } },
      ],
    });

    const report = await runDrill({
      chaos,
      drill,
      baselineMs: 30,
      simpleInjectMs: 30,
      intervalMs: 10,
      recoveryTimeoutMs: 60,
    });

    expect(report.injectedByPhase).toHaveLength(1);
    expect(report.injectedByPhase[0]!.label).toBe("injected");
    expect(chaos.log[0]).toBe("install:[r1]");
  });

  it("does NOT clear rules between phases or before recovery — only on exit", async () => {
    // Important property: the AI rehearsal needs faults to stay on during
    // recovery. The only "clear" should be the final one on shutdown.
    const chaos = mockChaos();
    const drill = makeDrill(() => ({ ok: true, latencyMs: 1, errorRate: 0 }), {
      phases: [
        { label: "a", durationMs: 20, rules: [{ id: "a", enabled: true, match: {}, inject: { kind: "awsError", probability: 1, awsError: { code: "X" } } }] },
        { label: "b", durationMs: 20, rules: [{ id: "b", enabled: true, match: {}, inject: { kind: "awsError", probability: 1, awsError: { code: "Y" } } }] },
      ],
    });

    await runDrill({
      chaos,
      drill,
      baselineMs: 20,
      intervalMs: 5,
      recoveryTimeoutMs: 40,
    });

    const clears = chaos.log.filter((s) => s === "clear");
    expect(clears).toHaveLength(1);
  });

  it("declares recovered when probe goes green for consecutiveGreen samples", async () => {
    let calls = 0;
    const drill = makeDrill(() => {
      calls++;
      // Fail for the first 8 probes (baseline + phases + start of recovery),
      // then go green so the recovery loop succeeds.
      return calls > 8
        ? { ok: true, latencyMs: 10, errorRate: 0 }
        : { ok: false, latencyMs: 50, errorRate: 1 };
    });
    const drillPhased: Drill = {
      ...drill,
      phases: [
        { label: "p", durationMs: 30, rules: [{ id: "r", enabled: true, match: {}, inject: { kind: "awsError", probability: 1, awsError: { code: "X" } } }] },
      ],
      acceptance: { errorRate: 0.01, consecutiveGreen: 3 },
    };

    const report = await runDrill({
      chaos: mockChaos(),
      drill: drillPhased,
      baselineMs: 30,
      intervalMs: 10,
      recoveryTimeoutMs: 5_000,
    });

    expect(report.recovered).toBe(true);
    expect(report.passed).toBe(true);
  });
});
