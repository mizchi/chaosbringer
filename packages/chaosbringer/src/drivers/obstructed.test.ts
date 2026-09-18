import { describe, expect, it } from "vitest";
import { isObstructed, type DriverCandidate } from "./types.js";

/**
 * `isObstructed` answers on positive evidence only, and the tests that
 * matter are the ones where it has to say "no" despite knowing nothing.
 * A false positive makes a driver skip a control that works, which is a
 * worse outcome than the wasted step it was trying to avoid.
 */
const candidate = (over: Partial<DriverCandidate> = {}): DriverCandidate => ({
  index: 0,
  selector: "#a",
  description: 'button "Continue"',
  type: "button",
  weight: 1,
  ...over,
});

describe("isObstructed", () => {
  it("is true when something else receives the click", () => {
    expect(isObstructed(candidate({ coveredBy: "<div#consent-backdrop>" }))).toBe(true);
  });

  it("is true when the element takes no pointer events", () => {
    expect(isObstructed(candidate({ inert: true }))).toBe(true);
  });

  it("is false for a plain visible candidate", () => {
    expect(isObstructed(candidate({ inViewport: true, inert: false }))).toBe(false);
  });

  it("is false when there is no geometry at all", () => {
    // The `scroll` target, and every target on a page the scrape could not
    // read. Unknown has to answer the same as fine.
    expect(isObstructed(candidate())).toBe(false);
  });

  it("is false off-screen, where the hit test could not run", () => {
    // `coveredBy` is only measured inside the viewport, so its absence
    // here is ignorance rather than evidence — and Playwright scrolls
    // before it acts, so the candidate is very likely clickable.
    expect(isObstructed(candidate({ inViewport: false, inert: false }))).toBe(false);
  });

  it("does not read an explicit undefined as evidence", () => {
    expect(isObstructed(candidate({ coveredBy: undefined, inert: undefined }))).toBe(false);
  });
});
