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
