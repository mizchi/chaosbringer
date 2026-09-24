import { describe, expect, it } from "vitest";
import { round } from "./util";

describe("round", () => {
  it("rounds to one decimal place", () => {
    expect(round(1.249)).toBe(1.2);
    expect(round(1.25)).toBe(1.3);
  });
  it("leaves integers untouched", () => {
    expect(round(42)).toBe(42);
  });
});
