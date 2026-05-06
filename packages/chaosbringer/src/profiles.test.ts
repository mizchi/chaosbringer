import { describe, expect, it } from "vitest";
import { profiles } from "./profiles.js";

const URL = /\/api\//;

describe("profiles", () => {
  it("flakyThirdPartyCdn returns slow + drop rules with conservative rates", () => {
    const rules = profiles.flakyThirdPartyCdn(URL);
    expect(rules).toHaveLength(2);
    expect(rules[0].fault.kind).toBe("delay");
    expect(rules[0].probability).toBeLessThan(0.5);
    expect(rules[1].fault.kind).toBe("abort");
    expect(rules[1].probability).toBeLessThanOrEqual(0.1);
    // every rule names itself so report aggregation per-profile is trivial
    expect(rules.every((r) => r.name?.startsWith("flaky-third-party-cdn:"))).toBe(true);
  });

  it("s3FivexxBurst is mostly 503 with a 500 sprinkle", () => {
    const rules = profiles.s3FivexxBurst(URL);
    expect(rules.map((r) => (r.fault.kind === "status" ? r.fault.status : null))).toEqual([503, 500]);
    // 503 should fire much more often than 500
    expect((rules[0].probability ?? 0) > (rules[1].probability ?? 0)).toBe(true);
  });

  it("regionalDegradation scales every probability by severity", () => {
    const lo = profiles.regionalDegradation({ urlPattern: URL, severity: 0.1 });
    const hi = profiles.regionalDegradation({ urlPattern: URL, severity: 0.9 });
    for (let i = 0; i < lo.length; i++) {
      expect((hi[i].probability ?? 0) > (lo[i].probability ?? 0)).toBe(true);
    }
  });

  it("regionalDegradation clamps severity to [0, 1]", () => {
    const negative = profiles.regionalDegradation({ urlPattern: URL, severity: -1 });
    const huge = profiles.regionalDegradation({ urlPattern: URL, severity: 999 });
    for (const r of negative) expect(r.probability).toBe(0);
    for (const r of huge) expect((r.probability ?? 0)).toBeLessThanOrEqual(1);
  });

  it("slowAuthService accepts ms / rate overrides", () => {
    const def = profiles.slowAuthService(URL);
    const custom = profiles.slowAuthService(URL, { ms: 500, rate: 0.1 });
    expect(def[0].fault.kind).toBe("delay");
    if (def[0].fault.kind === "delay") expect(def[0].fault.ms).toBe(3000);
    if (custom[0].fault.kind === "delay") expect(custom[0].fault.ms).toBe(500);
    expect(custom[0].probability).toBeCloseTo(0.1);
  });

  it("partialDataLoss mixes empty 200 and 5xx", () => {
    const rules = profiles.partialDataLoss(URL);
    const kinds = rules.map((r) => (r.fault.kind === "status" ? r.fault.status : null));
    expect(kinds).toContain(200);
    expect(kinds).toContain(500);
    // empty body lives on the 200 rule
    const empty = rules.find((r) => r.fault.kind === "status" && r.fault.status === 200);
    if (empty && empty.fault.kind === "status") {
      expect(empty.fault.body).toBe("");
    }
  });

  it("urlPattern is forwarded verbatim to every rule", () => {
    const pattern = /^\/api\/v2\//;
    const sets = [
      profiles.flakyThirdPartyCdn(pattern),
      profiles.s3FivexxBurst(pattern),
      profiles.regionalDegradation({ urlPattern: pattern }),
      profiles.slowAuthService(pattern),
      profiles.partialDataLoss(pattern),
    ];
    for (const rules of sets) {
      for (const r of rules) {
        expect(r.urlPattern).toBe(pattern);
      }
    }
  });
});
