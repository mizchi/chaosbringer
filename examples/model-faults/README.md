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

pnpm start            # buggy variant  -> 13 mismatches over 11 plans, exit 1
pnpm start:fixed      # corrected app  -> clean sheet,                 exit 0
pnpm test             # both, as assertions
pnpm dev              # just the app, at http://127.0.0.1:5173

pnpm test:patterns    # the seven patterns in patterns/, both variants each
pnpm pattern <name>   # one pattern, printing its coverage report
                      #   FIXED=1 pnpm pattern timeout-ladder
pnpm test:adversarial # redteam/ + patterns-audit/: the suites that attack the
                      # oracle and the patterns rather than the app
```

Nothing above needs Quint or a JVM: the plans in `model/plans/` and every
`patterns/<name>/plans/` are committed build artifacts. Enumeration (the step
that produces them) does — see *Regenerating*, and
[`patterns/README.md`](./patterns/README.md).

## What else is in here

This directory is four things, not one. The 4x4 checkout grid below is the
tutorial; the other three are where the work went.

| Directory | What it is |
|---|---|
| `model/` + `public/` + `run.ts` | **The tutorial.** One page, two operations, a 4x4 grid of failure states, two seeded bugs. Everything below is the same machinery pointed at harder shapes. |
| [`patterns/`](./patterns/) | **Seven real-world async shapes**, each a model + committed plans + a bridge + a page, each with a buggy and a fixed variant: retry idempotency, token refresh, optimistic rollback, pagination order, reconnect budget, stale-while-revalidate, timeout ladder. `patterns/README.md` is the how-to-add-one guide, and `vacuity.mjs` is the check that a `contract-forbids-*` query could ever have failed. |
| [`redteam/`](./redteam/) | **Attacks on the oracle.** Six holes a passing verdict used to walk through, each with an independent measurement that does not go through the oracle at all, plus a blue-team guard-walk that tries to make every new check fire on a *correct* app. |
| [`patterns-audit/`](./patterns-audit/) | **Attacks on the patterns.** Not "what can walk past the runner" but "does each pattern catch a bug of its own class that its own plans were not written for?". Replays each pattern's own committed plans and own bridge against a page carrying such a bug. |

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
| `model/profile.json` | This machine's measured timing envelope (`chaosbringer model calibrate`), from which the probe window and the injected delays are solved. A committed profile is a *foreign* measurement — regenerate it on your own hardware. |
| `targets.ts` | The one parser for `targets.txt`, shared by `run.ts`, `patterns/run-pattern.mts` and the tests. A status of `unreachable-live` / `unreachable-by-construction` is unreachable; matching the bare word `unreachable` is how both rows once got reported as *reachable*. |

### Regenerating (only when the model changes)

```bash
pnpm -F chaosbringer build         # compile.sh / pnpm compile call dist/cli.js
model/enumerate.sh                 # needs Quint + a JVM; ~14s per target
pnpm compile                       # traces -> plans
```

`enumerate.sh` also classifies its `contract-forbids-*` targets by calling
[`patterns/vacuity.mjs`](./patterns/vacuity.mjs) (`quint run`, ~3s, no JVM), so
`targets.txt` records *whether a witness was ever possible* rather than one word
for both cases. `node patterns/vacuity.mjs` does it for every model unit in
`examples/` at once.

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
