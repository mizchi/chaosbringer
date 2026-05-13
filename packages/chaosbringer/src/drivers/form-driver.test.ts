/**
 * formDriver unit tests using a stubbed Page. The real
 * Playwright-driven integration lives in fixtures/runner/e2e.test.ts.
 * These tests just exercise the no-form / declined-by-provider paths
 * and confirm the driver returns the right `DriverPick` shape.
 */
import { describe, expect, it } from "vitest";
import { createRng } from "../random.js";
import { formDriver } from "./form-driver.js";
import type { DriverStep } from "./types.js";

const noFormPage = {
  $$: async () => [],
};

const baseStep = (): DriverStep => ({
  url: "https://example.test/",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: noFormPage as any,
  candidates: [{ index: 0, selector: "#a", description: "a", type: "button", weight: 1 }],
  history: [],
  stepIndex: 0,
  rng: createRng(1),
  screenshot: async () => Buffer.from([]),
  invariantViolations: [],
});

describe("formDriver", () => {
  it("returns null when the page has no form (deferWhenNoForm default)", async () => {
    const driver = formDriver();
    expect(await driver.selectAction(baseStep())).toBeNull();
  });

  it("returns skip when deferWhenNoForm=false and no form is present", async () => {
    const driver = formDriver({ deferWhenNoForm: false });
    expect(await driver.selectAction(baseStep())).toEqual({ kind: "skip" });
  });

  it("exposes the provider name in the driver name", () => {
    const driver = formDriver();
    expect(driver.name).toMatch(/form\(default\)/);
  });
});
