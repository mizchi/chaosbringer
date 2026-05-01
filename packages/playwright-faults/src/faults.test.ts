import { describe, expect, it } from "vitest";
import { faults } from "./faults.js";

describe("faults helpers", () => {
  it("faults.status produces a status fault rule", () => {
    const rule = faults.status(500, { urlPattern: /\/api\// });
    expect(rule.fault).toEqual({ kind: "status", status: 500 });
    expect(rule.urlPattern).toBeInstanceOf(RegExp);
  });

  it("faults.status forwards body + contentType when provided", () => {
    const rule = faults.status(503, {
      urlPattern: "/api",
      body: "down",
      contentType: "text/plain",
    });
    expect(rule.fault).toEqual({
      kind: "status",
      status: 503,
      body: "down",
      contentType: "text/plain",
    });
  });

  it("faults.abort defaults errorCode to nothing (crawler supplies default)", () => {
    const rule = faults.abort({ urlPattern: /tracking/ });
    expect(rule.fault).toEqual({ kind: "abort" });
  });

  it("faults.abort passes errorCode through", () => {
    const rule = faults.abort({ urlPattern: "t", errorCode: "internetdisconnected" });
    expect(rule.fault).toEqual({ kind: "abort", errorCode: "internetdisconnected" });
  });

  it("faults.delay wraps ms", () => {
    const rule = faults.delay(2000, { urlPattern: "/slow" });
    expect(rule.fault).toEqual({ kind: "delay", ms: 2000 });
  });

  it("forwards common options (name, methods, probability)", () => {
    const rule = faults.status(500, {
      urlPattern: "/api",
      name: "api-500",
      methods: ["POST"],
      probability: 0.5,
    });
    expect(rule.name).toBe("api-500");
    expect(rule.methods).toEqual(["POST"]);
    expect(rule.probability).toBe(0.5);
  });

  it("omits common options when not set (no undefined pollution)", () => {
    const rule = faults.status(500, { urlPattern: "/api" });
    expect(rule).not.toHaveProperty("name");
    expect(rule).not.toHaveProperty("methods");
    expect(rule).not.toHaveProperty("probability");
  });
});

describe("lifecycle fault helpers", () => {
  it("faults.cpu wraps CPU throttle rate with a sensible default stage", () => {
    const lf = faults.cpu(4);
    expect(lf.action).toEqual({ kind: "cpu-throttle", rate: 4 });
    expect(lf.when).toBe("beforeNavigation");
  });

  it("faults.cpu forwards override stage / urlPattern / probability / name", () => {
    const lf = faults.cpu(2, {
      when: "afterLoad",
      urlPattern: /\/heavy\//,
      probability: 0.25,
      name: "cpu-2x-on-heavy",
    });
    expect(lf).toMatchObject({
      when: "afterLoad",
      probability: 0.25,
      name: "cpu-2x-on-heavy",
      action: { kind: "cpu-throttle", rate: 2 },
    });
    expect(lf.urlPattern).toBeInstanceOf(RegExp);
  });

  it("faults.cpu rejects rates < 1", () => {
    expect(() => faults.cpu(0.5)).toThrow(/rate/i);
    expect(() => faults.cpu(0)).toThrow(/rate/i);
    expect(() => faults.cpu(-1)).toThrow(/rate/i);
  });

  it("faults.clearStorage requires at least one scope and defaults stage to afterLoad", () => {
    const lf = faults.clearStorage({ scopes: ["localStorage", "cookies"] });
    expect(lf.action).toEqual({ kind: "clear-storage", scopes: ["localStorage", "cookies"] });
    expect(lf.when).toBe("afterLoad");
  });

  it("faults.clearStorage rejects empty scope list", () => {
    expect(() => faults.clearStorage({ scopes: [] })).toThrow(/scope/i);
  });

  it("faults.evictCache defaults to all caches and beforeActions stage", () => {
    const lf = faults.evictCache();
    expect(lf.action).toEqual({ kind: "evict-cache" });
    expect(lf.when).toBe("beforeActions");
  });

  it("faults.evictCache passes specific cacheNames through", () => {
    const lf = faults.evictCache({ cacheNames: ["v1", "static"] });
    expect(lf.action).toEqual({ kind: "evict-cache", cacheNames: ["v1", "static"] });
  });

  it("faults.tamperStorage produces a tamper action and defaults stage to afterLoad", () => {
    const lf = faults.tamperStorage({ scope: "localStorage", key: "auth", value: "" });
    expect(lf.action).toEqual({
      kind: "tamper-storage",
      scope: "localStorage",
      key: "auth",
      value: "",
    });
    expect(lf.when).toBe("afterLoad");
  });

  it("lifecycle helpers omit name / urlPattern / probability when not provided", () => {
    const lf = faults.cpu(4);
    expect(lf).not.toHaveProperty("name");
    expect(lf).not.toHaveProperty("urlPattern");
    expect(lf).not.toHaveProperty("probability");
  });
});
