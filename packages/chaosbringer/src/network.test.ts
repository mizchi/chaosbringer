import { describe, expect, it } from "vitest";
import { networkConditionsFor } from "./network.js";

describe("networkConditionsFor", () => {
  it("returns offline conditions for the offline profile", () => {
    const c = networkConditionsFor("offline");
    expect(c.offline).toBe(true);
    expect(c.downloadThroughput).toBe(0);
    expect(c.uploadThroughput).toBe(0);
  });

  it("returns slow-3g with 2s latency", () => {
    const c = networkConditionsFor("slow-3g");
    expect(c.offline).toBe(false);
    expect(c.latency).toBe(2000);
    expect(c.downloadThroughput).toBeGreaterThan(0);
    expect(c.uploadThroughput).toBeGreaterThan(0);
  });

  it("returns fast-3g with lower latency than slow-3g", () => {
    const slow = networkConditionsFor("slow-3g");
    const fast = networkConditionsFor("fast-3g");
    expect(fast.latency).toBeLessThan(slow.latency);
    expect(fast.downloadThroughput).toBeGreaterThan(slow.downloadThroughput);
  });
});
