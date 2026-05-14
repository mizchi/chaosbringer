import { describe, expect, it } from "vitest";
import { compileLoadFaultRules, faultFiringsFrom, faultStatsFrom } from "./fault-routes.js";

describe("compileLoadFaultRules", () => {
  it("returns [] for undefined / empty input", () => {
    expect(compileLoadFaultRules(undefined)).toEqual([]);
    expect(compileLoadFaultRules([])).toEqual([]);
  });

  it("compiles a string urlPattern into RegExp", () => {
    const compiled = compileLoadFaultRules([
      {
        urlPattern: "/api/users",
        fault: { kind: "status", status: 500 },
      },
    ]);
    expect(compiled.length).toBe(1);
    expect(compiled[0]!.pattern.test("https://x/api/users/1")).toBe(true);
  });

  it("normalises method list to uppercase", () => {
    const compiled = compileLoadFaultRules([
      {
        urlPattern: ".*",
        methods: ["post", "Put"],
        fault: { kind: "abort" },
      },
    ]);
    expect(compiled[0]!.methods).toEqual(["POST", "PUT"]);
  });

  it("skips invalid regex strings silently", () => {
    const compiled = compileLoadFaultRules([
      // unterminated character class
      { urlPattern: "[", fault: { kind: "abort" } },
      { urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    expect(compiled.length).toBe(1);
  });

  it("faultFiringsFrom returns timestamps per rule (including empty rules)", () => {
    const compiled = compileLoadFaultRules([
      { name: "fires", urlPattern: ".*", fault: { kind: "abort" } },
      { name: "quiet", urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    compiled[0]!.firings.push(1000, 1500, 2000);
    const firings = faultFiringsFrom(compiled);
    expect(firings.fires).toEqual([1000, 1500, 2000]);
    expect(firings.quiet).toEqual([]);
  });

  it("faultFiringsFrom auto-derives rule name when missing", () => {
    const compiled = compileLoadFaultRules([
      { urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    compiled[0]!.firings.push(123);
    const firings = faultFiringsFrom(compiled);
    expect(firings["fault-0"]).toEqual([123]);
  });

  it("faultStatsFrom reports per-rule counters", () => {
    const compiled = compileLoadFaultRules([
      {
        name: "api-500",
        urlPattern: ".*",
        fault: { kind: "status", status: 500 },
      },
    ]);
    compiled[0]!.matched = 5;
    compiled[0]!.injected = 3;
    expect(faultStatsFrom(compiled)).toEqual([{ rule: "api-500", matched: 5, injected: 3 }]);
  });
});
