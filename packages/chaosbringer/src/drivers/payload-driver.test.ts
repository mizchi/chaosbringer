import { describe, expect, it } from "vitest";
import { payloadDriver } from "./payload-driver.js";
import { XSS_PAYLOADS } from "./payloads.js";

describe("payloadDriver", () => {
  it("returns a driver with a recognisable name", () => {
    const d = payloadDriver({ payloads: ["xss"] });
    expect(d.name).toMatch(/^payload/);
  });

  it("accepts a custom string list as payloads", () => {
    const d = payloadDriver({ payloads: ["custom-string-1", "custom-string-2"] });
    expect(d.name).toMatch(/payload/);
  });

  it("recognises every default named set as named (not raw strings)", () => {
    expect(() => payloadDriver({ payloads: ["xss", "sqli", "path-traversal"] })).not.toThrow();
  });

  it("falls back to defaults when payloads list is empty", () => {
    const d = payloadDriver({ payloads: [] });
    expect(d.name).toContain("payload");
  });

  it("exposes XSS marker in default payload set", () => {
    expect(XSS_PAYLOADS.some((p) => p.includes("__xss_fired"))).toBe(true);
  });
});
