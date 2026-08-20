# Model-driven faults — enumerate the failure space instead of sampling it

Every other fault layer in chaosbringer fires on a **probability**. A seed
makes that reproducible, but it never makes it *enumerable*: after a run you
know which faults fired, never which combinations were never attempted. "Not
seen yet" and "cannot happen" look identical.

Model-driven faults close that gap. A temporal-logic model (Quint, or anything
that emits [ITF](https://apalache-mc.org/docs/adr/015adr-trace.html)) describes
the failure space; a model checker hands back one witness trace per reachable
state; each witness becomes a **`FaultPlan`** that replays deterministically,
with the model's own prediction as the oracle.

```
checkout.qnt ──quint verify──▶ ITF traces ──model compile──▶ plans/*.json
  (the spec)   one witness per      (JSON)     (committed)        │
               target state                                      │ model run
                                                                 ▼
                                        deterministic replay + oracle check
```

Only the last arrow needs chaosbringer at run time. Plans are committed
artifacts, so CI needs neither Quint nor a JVM.

## What you get that probability cannot give you

| | probability rolls | model-driven plans |
|---|---|---|
| Which combinations were attempted | unknown | enumerated, listed in the report |
| Two-failure states | ~9% of actions at `p=0.3` per rule | one dedicated run, always |
| "Cannot happen" | indistinguishable from "not seen" | reported as unreachable, with the depth bound |
| Expected outcome | generic invariants only | per-plan oracle from the model |
| Reproduction | `--seed` plus the whole crawl | one plan file, one action |

## The four pieces

### 1. The model is a specification, not a prediction

Set every knob to what a *correct* implementation must do. Then a disagreement
between model and app is a bug in one of the two — both worth a human:

```quint
pure val HANDLES_EVERY_REJECTION = true
pure val HAS_TIMEOUT = true

pure def expectedUi(s: str -> str): str =
  if (failed(s)) "error"
  else if (stateIs(s, "hung")) (if (HAS_TIMEOUT) "error" else "stuck")
  else if (allAre(s, "fulfilled")) "ready"
  else "loading"
```

Model **steps are I/O settlements**, not JS jobs — one step = one operation
reaching a terminal state. Anything finer is out of contract (see
[Determinism boundary](#determinism-boundary)).

### 2. Enumeration is witness-driven

To reach a state, ask the checker to prove it *unreachable* and keep the
counterexample:

```bash
quint verify checkout.qnt --max-steps=4 \
  --invariant='not(opState.get("cart") == "rejected" and opState.get("shipping") == "hung")' \
  --out-itf=traces/cart-rejected__shipping-hung.itf.json
# exit != 0 → counterexample written → reachable, and that trace IS the test
# exit == 0 → no witness within 4 steps → unreachable, and worth reporting
```

Two supporting tiers: `quint run --witnesses '<predicate>'` gives per-predicate
hit rates over N random traces in under a second (use it to skip Apalache
queries the simulator already covered), and `quint run --mbt` stamps
`mbt::actionTaken` onto each state so the compiler can read what fired without
a model-side log variable.

### 3. Plans are the interchange format

No probabilities, no seeds, no Quint concepts — reviewable JSON:

```json
{
  "name": "cart-rejected__shipping-hung",
  "schedule": [
    { "order": 0, "rule": "shipping", "outcome": "hang", "occurrence": 0 },
    { "order": 1, "rule": "cart", "outcome": "reject", "occurrence": 0 }
  ],
  "expect": { "ui": "error", "unhandledRejection": false }
}
```

Outcomes are model-level, and the runner maps them onto fault kinds:

| Outcome | Realised as | Layer |
|---|---|---|
| `pass` | nothing injected | — |
| `reject` | `reject-fetch` (TypeError) | runtime |
| `abort` | `reject-fetch` (DOMException `AbortError`) | runtime |
| `reject-body` | `reject-body` (`res.json()` rejects) | runtime |
| `hang` | `never-settle-fetch` | runtime |
| `status` | `faults.status(500)` | network |

One operation cannot mix layers: a client-side rejection issues no request, so
a network rule and a runtime fault on the same operation would number
occurrences differently. `compilePlanFaults` refuses that with an error.

### 4. The bridge carries what the model cannot know

```js
// model/bridge.mjs
export default {
  rules: { cart: /\/api\/cart$/, shipping: /\/api\/shipping$/ },
  action: async (page) => page.getByRole("button", { name: "Load order" }).click(),
  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // A page still loading when the settle window elapsed is what the model
    // calls "stuck" — the definition of a request nothing bounds.
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  settleMs: 1600,
};
```

## Three things the runner checks

1. **`ui`** — the model's predicted label vs `uiProbe`.
2. **`unhandledRejection`** — did a rejection escape every handler when the
   contract forbids it (or fail to escape when the model predicts one).
3. **`injection`** — *did the planned faults actually fire?* Without this a
   plan whose request the app never issues looks like a pass, and the coverage
   claim becomes a lie.

## Determinism boundary

What is enforceable: each operation's **outcome**, and per-operation
occurrence order (the app issues call 0 before call 1).

What is not: the order in which two *different* concurrent operations settle,
and microtask interleaving inside the page. There is no browser hook for
either, and patching `Promise.prototype.then` would change the semantics under
test.

So plans that inject the same multiset of outcomes but predict *different*
results are flagged `orderSensitive` at compile time and skipped by the runner
(`coverage.plansSkipped`) rather than run as a coin flip. If you hit that,
either the model over-specifies (an ordering assumption it never states) or
the operations should be modelled separately.

## Keeping the coverage claim honest

Model coverage is not code coverage. `coverageFingerprints: true` collects a
V8 digest per plan, and the report pairs plans the model calls distinct but
whose executed code was identical:

```
Collapsed plans (distinct model states, identical code coverage):
  cart-bodyRejected__shipping-rejected == cart-rejected__shipping-bodyRejected
```

That is a real finding from `examples/model-faults/`: the fixed app's error
path is symmetric, so the implementation does not distinguish the two states
the model does. Either the model is over-refined or the app is missing a
distinction — both are review-worthy, and neither is visible from the model
alone.

## Cost and where it runs

| Step | Cost | Needs |
|---|---|---|
| `quint run --witnesses` | ~0.3s / 500 traces | Quint |
| `quint verify` (one target) | ~14s incl. JVM start | Quint + JVM |
| `model compile` | milliseconds | Node |
| `model run` (per plan) | ~2s (one browser, one action) | Node + Chromium |

Enumerate at dev time or in a nightly job, commit the plans, and diff the
regenerated output against them so a model change that nobody recompiled
fails the nightly rather than the PR.

## Scaling guidance

Model **one user action** with ≤4 operations and ≤6 steps. The 4×4 grid in the
example is 16 targets, ~4 minutes to enumerate once and ~40 seconds to replay.
A 6-operation model with 5 outcomes each is 15 625 targets — that is not a
coverage plan, it is a hang.

## See also

- [`examples/model-faults/`](../../examples/model-faults/) — runnable: buggy
  variant fails 13 of 16 plans, `FIXED=1` passes all 16.
- [Deterministic fault schedules](../cookbook/deterministic-schedules.md) —
  the `schedule` primitive on its own, without a model.
- [Design doc](../superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md)
  — why it is shaped this way, and what was deliberately left out.
