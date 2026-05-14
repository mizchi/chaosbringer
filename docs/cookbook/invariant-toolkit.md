# Standard invariants toolkit

An `Invariant` is "what counts as broken even when no exception was thrown".
Without invariants, chaosbringer only catches console errors / network errors
/ uncaught exceptions — but a checkout that silently leaves the cart in
`pending` is still broken. Add an invariant per *user-visible* contract.

All four shapes below plug into `chaos({ invariants })` and
`scenarioLoad({ invariants })` identically.

## 1. No error toast lingers

The fastest signal. If your app has any visible failure UI (toast, banner,
modal), assert it's not visible after each step.

```ts
import type { Invariant } from "chaosbringer";

export const noErrorToast: Invariant = {
  name: "no-error-toast",
  async check({ page }) {
    const visible = await page.locator("[data-test=error-toast]").isVisible();
    return !visible || `error toast visible at ${page.url()}`;
  },
};
```

Returning `true` (or `undefined`) passes. Returning a `string` fails with that
message. Throwing also fails.

## 2. State machine — illegal transitions

For multi-page flows (auth, checkout, onboarding). Define the legal moves
once; the helper rejects anything not in the map.

```ts
import { stateMachineInvariant } from "chaosbringer";

type CartState = "empty" | "has-items" | "checking-out" | "purchased";

export const cartStateMachine = stateMachineInvariant<CartState>({
  name: "cart-state",
  initial: "empty",
  transitions: {
    "empty":         ["has-items"],
    "has-items":     ["empty", "checking-out"],
    "checking-out":  ["has-items", "purchased"],
    // "purchased" is terminal — omit it from the map
  },
  derive: async ({ page }) => {
    if (await page.locator("[data-test=thanks-page]").isVisible()) return "purchased";
    if (page.url().includes("/checkout"))                          return "checking-out";
    const count = await page.locator("[data-test=cart-count]").textContent();
    return Number(count) > 0 ? "has-items" : "empty";
  },
});
```

Fires `[cart-state] illegal transition "empty" → "purchased"` if the app
ever skips a stage.

## 3. Response shape — server returned what we expected

For SPAs that fetch JSON and silently render `undefined` on schema drift.
Use the run-scoped `state` map to remember the last response.

```ts
import type { Invariant } from "chaosbringer";

export const checkoutResponseShape: Invariant = {
  name: "checkout-response-shape",
  async check({ page, state }) {
    page.on("response", async (res) => {
      if (!res.url().includes("/api/checkout")) return;
      try {
        const body = await res.json();
        if (typeof body.orderId !== "string") {
          state.set("checkout-violation", `checkout returned no orderId: ${JSON.stringify(body)}`);
        }
      } catch {
        // Non-JSON 5xx — covered by other invariants.
      }
    });
    const v = state.get("checkout-violation");
    return v ? (v as string) : true;
  },
};
```

## 4. Monotonic counter — must only go up

Caches, audit logs, version numbers. If the value ever decreases between
visits, something rolled back.

```ts
import type { Invariant } from "chaosbringer";

export const monotonicSequence: Invariant = {
  name: "monotonic-sequence",
  async check({ page, state }) {
    const txt = await page.locator("[data-test=sequence]").textContent();
    const n = Number(txt);
    if (!Number.isFinite(n)) return true;
    const prev = state.get("seq") as number | undefined;
    state.set("seq", n);
    if (prev === undefined) return true;
    return n >= prev || `sequence regressed: ${prev} → ${n}`;
  },
};
```

## Wiring

```ts
import { chaos, scenarioLoad } from "chaosbringer";
import { noErrorToast, cartStateMachine, monotonicSequence } from "./invariants.js";

// Same array works for both surfaces.
const invariants = [noErrorToast, cartStateMachine, monotonicSequence];

await chaos({ baseUrl: "...", invariants });
await scenarioLoad({ baseUrl: "...", invariants, scenarios: [/* ... */] });
```

## Gotchas

- **`scenarioLoad` runs invariants after every *step***, not every page-lifecycle
  stage. The `when: "afterLoad" | "afterActions"` field on `Invariant` is
  honoured by `chaos()` but ignored by `scenarioLoad()`.
- **Run-scoped `state` is per-worker in `scenarioLoad`** (each worker gets its
  own Map) and per-run in `chaos()` (single Map for the whole crawl). The
  monotonic-counter pattern above works in both, but **cross-worker** state
  tracking does not.
- Invariant failure is recorded as a step / page error — it does *not* abort
  the run by itself. Combine with `assertSlo({ totals: { maxStepFailures: 0 }})`
  if you want a single failure to flip CI red.

## Related

- Feature doc on state machines: search for `stateMachineInvariant` in source — `packages/chaosbringer/src/state-machine-invariants.ts` has the full API.
- The crawler's invariant model: [`docs/recipes/drivers.md`](../recipes/drivers.md)
