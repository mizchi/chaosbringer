import { describe, expect, it } from "vitest";
import {
  combinePayloadSets,
  DEFAULT_PAYLOAD_SETS,
  SQLI_PAYLOADS,
  XSS_PAYLOADS,
} from "./payloads.js";

describe("payload sets", () => {
  it("has every advertised named set populated", () => {
    for (const [name, set] of Object.entries(DEFAULT_PAYLOAD_SETS)) {
      expect(set.length, name).toBeGreaterThan(0);
    }
  });

  it("XSS_PAYLOADS contains the canonical detection marker", () => {
    expect(
      XSS_PAYLOADS.some((p) => p.includes("__xss_fired")),
    ).toBe(true);
  });

  it("SQLI_PAYLOADS contains the canonical tautology", () => {
    expect(SQLI_PAYLOADS.some((p) => p.includes("OR '1'='1"))).toBe(true);
  });

  it("combinePayloadSets concatenates sets in order", () => {
    const combined = combinePayloadSets(["xss", "sqli"]);
    expect(combined.length).toBe(XSS_PAYLOADS.length + SQLI_PAYLOADS.length);
    expect(combined[0]).toBe(XSS_PAYLOADS[0]);
  });
});
