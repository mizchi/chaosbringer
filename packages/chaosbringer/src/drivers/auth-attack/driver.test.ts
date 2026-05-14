/**
 * Unit-level tests for `authAttackDriver` selection behaviour. The
 * per-attack logic is covered by the E2E test against the vulnerable
 * fixture site — here we just exercise the driver's state machine
 * (return null on non-auth pages, custom Pick on auth pages, respect
 * `maxAttacksPerUrl`, dispatch via custom detector).
 */
import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { authAttackDriver } from "./driver.js";
import type { DetectedAuthForm } from "./types.js";
import type { DriverStep } from "../types.js";

function fakeStep(url: string): DriverStep {
  return {
    url,
    page: { url: () => url } as unknown as Page,
    candidates: [],
    history: [],
    stepIndex: 0,
    rng: { next: () => 0.5 } as DriverStep["rng"],
    screenshot: async () => Buffer.from(""),
    invariantViolations: [],
  };
}

function fakeForm(type: "login" | "signup" = "login"): DetectedAuthForm {
  // The driver only inspects `type` from the form during selection;
  // perform() re-detects via the real detector. We stub a minimal
  // object that's never deeply traversed.
  return {
    type,
    form: {} as DetectedAuthForm["form"],
    usernameField: {} as DetectedAuthForm["usernameField"],
    passwordField: {} as DetectedAuthForm["passwordField"],
    submitButton: {} as DetectedAuthForm["submitButton"],
  };
}

describe("authAttackDriver selection", () => {
  it("returns null when the detector finds no form", async () => {
    const driver = authAttackDriver({
      detectForm: async () => null,
    });
    expect(await driver.selectAction(fakeStep("https://x/"))).toBeNull();
  });

  it("returns a custom Pick when a form is detected", async () => {
    const driver = authAttackDriver({
      detectForm: async () => fakeForm("login"),
    });
    const pick = await driver.selectAction(fakeStep("https://x/login"));
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("custom");
    if (pick!.kind === "custom") {
      expect(pick.source).toBe("auth-attack");
      expect(pick.reasoning).toMatch(/login/);
    }
  });

  it("attacks each URL at most maxAttacksPerUrl times (default 1)", async () => {
    const driver = authAttackDriver({
      detectForm: async () => fakeForm("login"),
    });
    const a = await driver.selectAction(fakeStep("https://x/login"));
    const b = await driver.selectAction(fakeStep("https://x/login"));
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("re-attacks distinct URLs even with the default budget", async () => {
    const driver = authAttackDriver({
      detectForm: async () => fakeForm("login"),
    });
    const a = await driver.selectAction(fakeStep("https://x/login"));
    const b = await driver.selectAction(fakeStep("https://x/account/login"));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("maxAttacksPerUrl > 1 allows re-attack of the same URL", async () => {
    // Sequential calls — the crawler invokes selectAction serially.
    // Parallel invocations all see seen=0 before any writes back; that
    // race is fine in practice because the crawler is single-threaded.
    const driver = authAttackDriver({
      detectForm: async () => fakeForm("login"),
      maxAttacksPerUrl: 3,
    });
    const calls = [];
    for (let i = 0; i < 4; i++) {
      calls.push(await driver.selectAction(fakeStep("https://x/login")));
    }
    expect(calls.filter(Boolean).length).toBe(3);
  });

  it("findings collected via getFindings() are returned as a snapshot", () => {
    const driver = authAttackDriver({});
    expect(driver.getFindings()).toEqual([]);
  });

  it("swallows detector exceptions and defers", async () => {
    const driver = authAttackDriver({
      detectForm: async () => {
        throw new Error("boom");
      },
    });
    expect(await driver.selectAction(fakeStep("https://x/login"))).toBeNull();
  });

  it("forwards onFinding configuration through the type — call surface", () => {
    const onFinding = vi.fn();
    const driver = authAttackDriver({ onFinding });
    expect(typeof driver.selectAction).toBe("function");
    expect(driver.getFindings()).toEqual([]);
    // onFinding is fired from inside perform(); the E2E test exercises
    // the wiring end-to-end.
    expect(onFinding).not.toHaveBeenCalled();
  });
});
