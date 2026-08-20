# Model-driven fault coverage

A Quint model of a checkout page's load contract enumerates **every** failure
state, each state replays as a deterministic chaosbringer run, and the model
itself is the oracle.

The point is a claim a probability sweep cannot make:

```
=== MODEL COVERAGE ===
Spec: model/checkout.qnt
States: 16/18 reachable (depth <= 4), 2 unreachable
Plans run: 16
Mismatches: 13
  [unhandledRejection] cart-fulfilled__shipping-rejected: a rejection escaped every handler, which the model's contract forbids
  [ui] cart-hung__shipping-fulfilled: model predicted ui="error", page reported "stuck"
  …
```

Sixteen states enumerated, two proved unreachable, every one exercised — not
"we rolled dice 10 000 times and something broke".

## Run it

```bash
pnpm install

pnpm start          # buggy variant  -> 13 mismatches, exit 1
pnpm start:fixed    # corrected app  -> clean sheet,   exit 0
pnpm test           # both, as assertions
pnpm dev            # just the app, at http://127.0.0.1:5173
```

Neither `start` nor `test` needs Quint or a JVM: the plans in `model/plans/`
are committed build artifacts.

## The app

`server.ts` + `public/` — Hono, two endpoints, one page with a "Load order"
button that fetches `/api/cart` and `/api/shipping` for one user action.
Divergences are gated on `FIXED` (the same convention as the dogfood
playground), and the buggy variant is the default because that is the one the
pipeline is supposed to catch.

Two seeded bugs, both patterns that ship constantly:

| | Bug | Symptom the model catches |
|---|---|---|
| **BUG-1** | Nothing bounds the load — no deadline, no `AbortController` | A response that never arrives leaves the spinner up. The contract says a bounded request ends in `error`; the page reports `stuck` (5 plans) |
| **BUG-2** | Eager start, sequential await: both requests start at once to avoid a waterfall, then are awaited one after another | The second promise has no handler attached at the moment it rejects, so the rejection escapes as `unhandledrejection` — even in the runs where the code does eventually `await` it inside a `try` (8 plans) |

BUG-2 is worth dwelling on, because it is **not** what `Promise.all` does:
`Promise.all` subscribes to every input immediately, so a second rejection
there is handled. The bug is the sequential `await`. An app with a global
`unhandledrejection` hook wired to error reporting gets spurious alerts from
this pattern, and a random fault injector only finds it when two specific
requests fail in one action.

## The pipeline

```
model/checkout.qnt  --enumerate.sh (Apalache)-->  model/traces/*.itf.json
                    --chaosbringer model compile-->  model/plans/*.plan.json   (committed)
                    --runPlans + model/bridge.mjs-->  coverage report
```

| File | Role |
|---|---|
| `model/checkout.qnt` | The **specification**: per-operation lifecycle, how the combinator folds it, and what a correct implementation must do. Not a prediction of the app. |
| `model/enumerate.sh` | Witness-driven enumeration. For each target state, ask Apalache to prove it unreachable; the counterexample *is* the test case. Dev-time only. |
| `model/targets.txt` | What was asked and what came back — including the states proved unreachable, which is the half a probability sweep can never report. |
| `model/traces/` | One ITF witness per reachable state, straight from `quint verify`. |
| `model/plans/` | Compiled `FaultPlan`s: per-operation outcomes + the oracle. Reviewable JSON, no Quint concepts. |
| `model/bridge.mjs` | The three things the model cannot know: which URL each operation is, how to fire the action, how to read the UI back as a model label. |

### Regenerating (only when the model changes)

```bash
model/enumerate.sh                 # needs Quint + a JVM; ~14s per target
pnpm compile                       # traces -> plans
```

`enumerate.sh` walks a 4×4 grid of per-operation terminal states
(`fulfilled` / `rejected` / `bodyRejected` / `hung`) plus the two states the
contract forbids. Those two must come back **unreachable** — a witness there
would mean the spec is wrong, not the app.

## What this model deliberately leaves out

- **Cancellation.** A mixed "one request cancelled, another failed" state has
  no order-independent answer: `Promise.all` surfaces whichever error happened
  first. Since this model's steps are *settlements* and not an ordering, adding
  `aborted` here would produce plans whose verdict is a coin flip. Cancel
  semantics deserve their own model, with the ordering assumption written down.
- **Microtask interleaving.** Not enforceable from a browser — see the
  determinism boundary in
  [`docs/superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md`](../../docs/superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md).
  Plans whose predicted outcome depends on cross-operation order are flagged
  `orderSensitive` at compile time and skipped rather than run flakily.
- **Implementation coverage.** The model enumerates *model* states. Whether two
  distinct model states actually exercise distinct code is a separate question,
  which V8 coverage fingerprints answer (`collapsedPlans` in the report).
