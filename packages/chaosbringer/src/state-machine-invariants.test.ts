import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import type { InvariantContext } from "./types.js";
import {
  stateMachineCurrent,
  stateMachineInvariant,
  stateMachineKey,
  validateTransition,
} from "./state-machine-invariants.js";

type AuthState = "anonymous" | "logged-in" | "in-checkout" | "purchased";
const AUTH_TRANSITIONS: Partial<Record<AuthState, readonly AuthState[]>> = {
  anonymous: ["logged-in"],
  "logged-in": ["anonymous", "in-checkout"],
  "in-checkout": ["logged-in", "purchased"],
  // `purchased` is terminal — left out on purpose.
};

describe("validateTransition", () => {
  it("treats self-loops as always legal", () => {
    expect(validateTransition("logged-in", "logged-in", AUTH_TRANSITIONS)).toEqual({
      ok: true,
      prev: "logged-in",
      next: "logged-in",
    });
  });

  it("accepts transitions listed in the map", () => {
    expect(validateTransition("anonymous", "logged-in", AUTH_TRANSITIONS).ok).toBe(true);
    expect(validateTransition("logged-in", "in-checkout", AUTH_TRANSITIONS).ok).toBe(true);
    expect(validateTransition("in-checkout", "purchased", AUTH_TRANSITIONS).ok).toBe(true);
  });

  it("rejects transitions not listed in the map", () => {
    const verdict = validateTransition("anonymous", "purchased", AUTH_TRANSITIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/illegal transition "anonymous" → "purchased"/);
    expect(verdict.reason).toMatch(/allowed: "logged-in"/);
  });

  it("rejects transitions out of a terminal state", () => {
    const verdict = validateTransition("purchased", "anonymous", AUTH_TRANSITIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/"purchased" is terminal/);
  });

  it("rejects transitions out of a state whose entry is an empty array", () => {
    const verdict = validateTransition(
      "purchased",
      "logged-in",
      { ...AUTH_TRANSITIONS, purchased: [] },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/allowed: none/);
  });
});

describe("stateMachineKey + stateMachineCurrent", () => {
  it("namespaces keys with sm:", () => {
    expect(stateMachineKey("auth")).toBe("sm:auth");
  });

  it("falls back to `initial` when no entry has been written", () => {
    const state = new Map<string, unknown>();
    expect(stateMachineCurrent("auth", "anonymous", state)).toBe("anonymous");
  });

  it("returns the recorded label after a write", () => {
    const state = new Map<string, unknown>();
    state.set("sm:auth", "logged-in");
    expect(stateMachineCurrent("auth", "anonymous", state)).toBe("logged-in");
  });

  it("ignores non-string entries (defensive — only the SM should write the slot)", () => {
    const state = new Map<string, unknown>();
    state.set("sm:auth", 42);
    expect(stateMachineCurrent("auth", "anonymous", state)).toBe("anonymous");
  });
});

describe("stateMachineInvariant", () => {
  function ctxFor(state: Map<string, unknown>, url = "/dashboard"): InvariantContext {
    return {
      page: {} as Page,
      url,
      errors: [],
      state,
    };
  }

  it("compiles to an Invariant that defaults `when` to afterActions", () => {
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => "anonymous",
    });
    expect(inv.name).toBe("auth");
    expect(inv.when).toBe("afterActions");
  });

  it("records the initial label on the first derive", async () => {
    const state = new Map<string, unknown>();
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => "anonymous",
    });
    const result = await inv.check(ctxFor(state));
    expect(result).toBeUndefined();
    expect(state.get("sm:auth")).toBe("anonymous");
  });

  it("accepts a legal transition and updates the state", async () => {
    const state = new Map<string, unknown>();
    let pageState: AuthState = "anonymous";
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => pageState,
    });

    expect(await inv.check(ctxFor(state))).toBeUndefined(); // anonymous → anonymous
    pageState = "logged-in";
    expect(await inv.check(ctxFor(state))).toBeUndefined(); // anonymous → logged-in
    expect(state.get("sm:auth")).toBe("logged-in");
    pageState = "in-checkout";
    expect(await inv.check(ctxFor(state))).toBeUndefined(); // logged-in → in-checkout
    expect(state.get("sm:auth")).toBe("in-checkout");
  });

  it("returns a failure string on an illegal transition and does NOT update state", async () => {
    const state = new Map<string, unknown>();
    state.set("sm:auth", "anonymous");
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => "purchased",
    });
    const result = await inv.check(ctxFor(state));
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/illegal transition "anonymous" → "purchased"/);
    // Stays put: subsequent legal moves are still measured against `anonymous`.
    expect(state.get("sm:auth")).toBe("anonymous");
  });

  it("forwards prev into derive so the user can branch on it", async () => {
    const state = new Map<string, unknown>();
    const seen: string[] = [];
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: ({ prev }) => {
        seen.push(prev);
        return prev === "anonymous" ? "logged-in" : prev;
      },
    });
    await inv.check(ctxFor(state));
    await inv.check(ctxFor(state));
    expect(seen).toEqual(["anonymous", "logged-in"]);
  });

  it("does not interfere with a different state machine sharing the same bag", async () => {
    const state = new Map<string, unknown>();
    const auth = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => "logged-in",
    });
    type Theme = "light" | "dark";
    const theme = stateMachineInvariant<Theme>({
      name: "theme",
      initial: "light",
      transitions: { light: ["dark"], dark: ["light"] },
      derive: () => "dark",
    });
    expect(await auth.check(ctxFor(state))).toBeUndefined();
    expect(await theme.check(ctxFor(state))).toBeUndefined();
    expect(state.get("sm:auth")).toBe("logged-in");
    expect(state.get("sm:theme")).toBe("dark");
  });

  it("propagates urlPattern and respects the user's `when`", () => {
    const inv = stateMachineInvariant<AuthState>({
      name: "auth",
      initial: "anonymous",
      transitions: AUTH_TRANSITIONS,
      derive: () => "anonymous",
      when: "afterLoad",
      urlPattern: /\/app\//,
    });
    expect(inv.when).toBe("afterLoad");
    expect(inv.urlPattern).toBeInstanceOf(RegExp);
  });
});
