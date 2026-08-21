# Model-driven Promise fault coverage (Quint)

**Date:** 2026-08-20
**Branch:** `claude/promise-exception-state-coverage-3bfyl0`
**Status:** Implemented. See [What shipped](#what-shipped) for the four places
the implementation deviates from this design, and why.

## What shipped

All four phases landed. Four deliberate deviations from the design below:

1. **Order-sensitivity is detected across the plan *set*, not per plan.** The
   design said the compiler would reject a plan whose adjacent steps target
   the same rule. That test is wrong: per-rule occurrence order *is*
   deterministic (the app issues call 0 before call 1). What is not
   enforceable is order *between* operations — so `markOrderSensitivePlans`
   flags plans that inject the same multiset of outcomes yet predict
   different results, and the runner skips them (`coverage.plansSkipped`)
   instead of producing a coin-flip verdict.
2. **A plan's `hang` outcome maps to the runtime `never-settle-fetch`, not
   the network `hang`.** No request is issued, so `networkidle` still fires
   and the page load isn't held hostage to the fault; the app simply never
   gets its answer. The network `hang` remains for non-fetch requests.
3. **One operation cannot mix fault layers.** A client-side rejection issues
   no request, so a network rule and a runtime fault on the same operation
   would number occurrences differently. `compilePlanFaults` refuses it with
   an error naming the operation.
4. **The CLI is `model compile` + `model run`; there is no `model
   enumerate`.** Enumeration is a `quint verify` loop over a target list
   (`examples/model-faults/model/enumerate.sh`). Wrapping it in the CLI would
   bake Apalache into the package whose whole point is not needing it at run
   time.

One addition: `CrawlReport.coverageFingerprint` (a digest of the V8 function
fingerprints a run executed) makes the model/implementation cross-check real.
In the example app it immediately found a genuine collapse — the fixed
variant's symmetric error path means `cart-bodyRejected__shipping-rejected`
and `cart-rejected__shipping-bodyRejected` execute identical code, so the
model distinguishes two states the implementation does not.

## Problem

Every fault layer in this repo fires on a **probability roll**:

```ts
// packages/chaosbringer/src/crawler.ts:1418
const prob = compiled.rule.probability ?? 1;
if (prob < 1 && this.rng.next() >= prob) continue;
```

`lifecycle-faults.ts:96` and the in-page `roll()` in `runtime-faults.ts:150`
do the same thing. The seed makes a run *reproducible*, but it does not make
the fault space *enumerable*. Three consequences:

1. **No coverage statement.** After a run we know which faults fired, never
   which failure *combinations* were never attempted. "Not seen yet" and
   "cannot happen" are indistinguishable.
2. **Combination faults are exponentially unlikely.** The interesting Promise
   bugs are combinational, not single-fault. The canonical one: two requests
   started eagerly to avoid a waterfall, then awaited one after another —

   ```js
   const cartReq = fetchJson("/api/cart");
   const shippingReq = fetchJson("/api/shipping");
   const cart = await cartReq;         // rejects -> we return…
   const shipping = await shippingReq; // …so nothing was ever attached here
   ```

   `shippingReq`'s rejection has no handler at the moment it rejects, so it
   escapes as `unhandledrejection` — and any global handler wired to error
   reporting fires. (This is specifically *not* what `Promise.all` does:
   `Promise.all` subscribes to every input immediately, so a second rejection
   there is handled. The bug is the sequential `await`.) Hitting it needs
   *both* requests to fail *in the same action*: at `probability: 0.3` per
   rule that is ~9% of actions, and the crawler must also be on the right
   page, in the right state, and click the right button.
3. **No oracle.** A random run can only assert generic invariants ("no
   unhandled rejection anywhere"). It cannot assert *this* schedule should end
   in `error`, not `loading` — because nothing knows what the schedule was.

The fault *kinds* are also thin where Promise semantics live. `RuntimeAction`
(`packages/playwright-faults/src/types.ts`) has exactly two members —
`flaky-fetch` and `clock-skew`. There is no "never settles", no
`AbortError`, and no "`res.json()` rejects after the fetch resolved" — the
single most commonly missed `catch` in real apps.

## Goal

Enumerate the failure-mode state space of an async operation with a temporal
model (Quint), and drive **each enumerated state** as a deterministic
chaosbringer run — with the model supplying the expected outcome as an oracle.

Concretely, replace "roll dice 10 000 times and hope" with:

```
8 target states → 5 reachable (minimal witness trace each) + 3 proved
unreachable within depth 5 → 5 deterministic runs, each with an oracle
```

Those numbers are measured, not hypothetical ([Appendix A](#appendix-a--feasibility-spike)).

## Scope

**In scope:**

- Deterministic, occurrence-indexed fault injection (`FaultRule.schedule`) as
  a peer of `probability`, on all four fault layers that currently roll dice.
- New fault kinds covering the Promise-spec surface: never-settling requests,
  `AbortError` rejection, body-consume (`res.json()`) rejection,
  rejected-thenable resolution.
- A `FaultPlan` interchange format, plus a compiler from Quint ITF
  counterexample traces to `FaultPlan`.
- A plan runner that replays one plan per `chaos()` run and checks the plan's
  oracle, reporting model-state coverage.
- `chaosbringer model enumerate` (dev-time, needs Quint + JVM) and
  `chaosbringer model run` (runtime, pure Node).
- Cross-checking model states against V8 coverage via
  `@mizchi/playwright-v8-coverage`, to detect model/implementation divergence.

**Explicitly out of scope:**

- Microtask-level interleaving control. See
  [Determinism boundary](#determinism-boundary) — we control fault *settlement
  order at the I/O boundary*, not the JS job queue. A model that distinguishes
  two states only by microtask order is out of contract.
- Shipping a Quint spec of the whole ECMAScript Promise algorithm. The models
  are per-feature and small by design (≤4 ops, ≤6 steps).
- Making Quint or a JVM a runtime dependency of `chaosbringer`. Plans are
  build artifacts, committed to the repo.
- Unbounded verification. Enumeration is bounded model checking; every
  "unreachable" claim carries its depth bound.

## Architecture

Four stages, three of which are dev-time:

```
promise.qnt ──(1) quint verify──▶ ITF traces ──(2) compile──▶ plans/*.json
   (model)      witness per          (JSON)        pure fn      (committed)
                target state                                        │
                                                                    │ (3) replay
                                          chaosbringer model run ◀──┘
                                                     │
                                          (4) oracle check + coverage report
```

Stages 1–2 run in a nightly job or by hand when the model changes. Stage 3–4
is what CI runs on every PR, with no Quint and no JVM in the image.

### Why a model buys anything

| | probability rolls (today) | model-driven plans |
|---|---|---|
| Which combinations were attempted | unknown | enumerated, listed in the report |
| Second-rejection / unhandled path | ~9% per action at `p=0.3` | 1 dedicated run, always |
| "Cannot happen" | indistinguishable from "not seen" | `UNREACHABLE (≤ k steps)` |
| Expected outcome | generic invariants only | per-plan oracle from the model |
| Reproduction | `--seed` + the whole crawl | one plan file, one action |
| Cost | one long run | one short run per reachable state |

### What the model describes

The model is **not** a model of the app. It is a model of the *fault space plus
the Promise contract*, with three parts:

1. **Per-operation lifecycle** — `unstarted → pending → {fulfilled, rejected,
   hung}`. One "operation" is one logical request the action fires, and maps
   1:1 to a fault rule.
2. **Combinator semantics** — how `Promise.all` / `allSettled` / `race` /
   `any` fold those per-op states into one settlement, *including which
   rejections end up without a handler*. This is where the Promise spec lives,
   and it is the part the random injector cannot reason about at all.
3. **Handler contract knobs** — does the app attach `.catch`? is there a
   timeout / `AbortController` for a hung request? These are `pure val`
   constants. Setting them to the *intended* design (has catch, has timeout)
   makes every trace's oracle say "no unhandled rejection" — so any real
   unhandled rejection observed in the browser is a bug. Flipping one to
   `false` turns the model into a *predictor*: it names the traces that would
   break if the app is missing that handler.

A state is the tuple `(opState, ui, unhandled)`, where `ui` is the
app-observable label the browser side can derive (`idle / loading / done /
error / stuck`) — deliberately the same vocabulary as the existing
`stateMachineInvariant` (`packages/chaosbringer/src/state-machine-invariants.ts`),
so the oracle wires into machinery that already exists.

### Enumeration strategy: witness-driven

Quint's simulator is random — the same "hope" problem one level up. Exhaustive
enumeration comes from Apalache, used **inverted**: to reach a state, ask for a
proof that it is unreachable and take the counterexample.

```bash
# P = the state we want to reach
quint verify promise.qnt --max-steps=5 --invariant='not(P)' --out-itf=P.itf.json
# exit != 0  → counterexample written  → P reachable, P.itf.json IS the test case
# exit == 0  → no counterexample       → P unreachable within 5 steps
```

The target set is generated as the cross product of the state-variable domains
(`ui × unhandled` in the spike; a real model adds per-op states or a
`covered` flag). Unreachable targets are reported, not silently dropped — that
is the coverage statement we do not have today.

Two supporting Quint features:

- `--witnesses 'unhandled' 'ui == "stuck"'` on `quint run` gives per-predicate
  hit rates over N random traces in seconds. Use as the cheap pre-flight tier:
  anything already witnessed by the simulator does not need an Apalache query.
- `--mbt` stamps `mbt::actionTaken` and `mbt::nondetPicks` onto every ITF
  state, so the compiler reads the fired action and its arguments directly
  instead of reconstructing them from state diffs.

### Plan format

The interchange contract between "model world" and "browser world". No
probabilities, no seeds, no Quint concepts:

```jsonc
{
  "name": "error_true",
  "spec": "promise.qnt",           // provenance
  "modelSteps": 3,
  "schedule": [                     // per fault rule, per occurrence, in order
    { "rule": "opA", "occurrence": 0, "outcome": "reject" },
    { "rule": "opB", "occurrence": 0, "outcome": "reject" }
  ],
  "expect": {
    "ui": "error",                  // checked via the plan's uiProbe
    "unhandledRejection": false     // model asserts the contract holds
  }
}
```

`schedule` is the injection plan; `expect` is the oracle. A plan is a
self-contained regression artifact: it survives model edits, it diffs
readably in review, and replaying it needs nothing but `chaosbringer`.

### Determinism boundary

The honest limit of this design, stated up front so the model is not written
past it.

**What we can enforce:** the *outcome* of each logical operation, and the
*relative settlement order at the I/O boundary*. Playwright's `route()` handler
owns when a response is delivered, so "A rejects, then B rejects" is
enforceable by holding B's route until A's has been fulfilled — a barrier.

**What we cannot enforce:** the microtask/job-queue interleaving *inside* the
page between two already-settled promises. There is no supported hook, and
patching `Promise.prototype.then` to fake one changes the semantics under test.

Consequences for the model:

- Model steps are **I/O settlement events**, not JS jobs. One step = one
  operation reaching a terminal state.
- Two model states that differ only by job-queue order are **not** distinct
  test cases. The compiler rejects a plan whose two adjacent steps target the
  same rule with no intervening observable, so this failure mode surfaces at
  compile time instead of as a flaky run.
- The plan runner applies the barrier per planned action: rule *k+1*'s route
  is released only after rule *k*'s outcome has been applied. Without the
  barrier the arrival order of concurrent requests decides the order and the
  plan becomes a lie.

One design rule follows: **one fault rule per logical operation**, keyed by
distinct `urlPattern`. Then each rule has its own occurrence counter and a
plan does not depend on the arrival order of concurrent requests at all —
`Promise.all([fetch("/api/a"), fetch("/api/b")])` is order-independent by
construction. Two occurrences of the *same* URL in one action need the barrier.

## Component changes

### `@mizchi/playwright-faults`

#### `FaultRule.schedule` — deterministic occurrence-indexed injection

```ts
export type FaultDecision = "pass" | "inject";

export interface FaultSchedule {
  /** Decision for occurrence 0, 1, 2, … of this rule. */
  decisions: ReadonlyArray<FaultDecision>;
  /** What to do past the end of `decisions`. Default: "pass". */
  afterEnd?: "pass" | "inject" | "repeat";
}

export interface FaultRule {
  // …
  /** Mutually exclusive with `probability` (validated, throws on both). */
  schedule?: FaultSchedule;
}
```

Plus one pure, unit-testable decision helper mirroring
`shouldFireProbability`, so no layer grows its own branch:

```ts
export function decideFault(
  rule: { probability?: number; schedule?: FaultSchedule },
  occurrence: number,
  rng: Rng,
): FaultDecision;
```

The same field and helper land on `LifecycleFault`, `IframeFault`, and
`RuntimeFault`. The in-page script (`buildRuntimeFaultsScript`) already keys
its stats by fault *index* and already counts `matched`, so its `roll()`
becomes a lookup on `decisions[matched - 1]` — no new plumbing.

#### New fault kinds

Network (`Fault`):

| Kind | Semantics | Bug class it exposes |
|---|---|---|
| `hang` | Hold the route; never fulfil. Optional `releaseAfterMs`, else released at action teardown via `route.abort("timedout")`. | Spinner with no timeout; a load that can never finish |

Runtime (`RuntimeAction`):

| Kind | Semantics | Bug class it exposes |
|---|---|---|
| `reject-fetch` (generalises `flaky-fetch`) | `rejectAs: "TypeError" \| "AbortError"` | `catch` that only handles one error shape; abort treated as failure |
| `never-settle-fetch` | Return a promise that never settles — no request is made | Client-side hang; distinct from network `hang` in that no route ever matches |
| `reject-body` | `fetch` resolves, then `res.json()` / `res.text()` rejects | **The most commonly missed `catch`**: `await res.json()` outside the try |
| `resolve-rejected-thenable` | Resolve with `{ then(_, rej) { rej(e) } }` | Thenable-assimilation paths; a rejection that arrives one microtask late |

`flaky-fetch` stays as a deprecated alias of `reject-fetch` with
`rejectAs: "TypeError"`, so no existing config breaks.

#### Draining held routes

`hang` needs a lifecycle owner: the crawler collects held `Route` objects per
page and drains them (`abort("timedout")`) on page close, so a hung fault
cannot wedge the run. Held-route count goes on the report.

### `chaosbringer`

#### `crawler.ts` route handler

```ts
compiled.matched++;
if (decideFault(compiled.rule, compiled.matched - 1, this.rng) === "pass") continue;
compiled.injected++;
```

`compiled.matched` is already the occurrence counter, so this is a
one-line-for-one-line replacement of the roll at `crawler.ts:1418`. Counters
must be reset per planned action — the plan runner owns that (see below).

#### New module: `packages/chaosbringer/src/model/`

| File | Responsibility |
|---|---|
| `itf.ts` | ITF (Informal Trace Format) parser: `#map` / `#tup` / variant decoding, `mbt::*` extraction. Pure. |
| `plan.ts` | `FaultPlan` type, `compilePlan(itf, opts): FaultPlan`, validation (barrier ambiguity, unknown rule ids). Pure. |
| `runner.ts` | `runPlan(plan, opts)`: builds scheduled rules, runs a single-action `chaos()`, evaluates the oracle. |
| `coverage.ts` | Aggregate `ModelCoverage` across plans, incl. the V8 divergence check. |

`compilePlan` and `itf.ts` being pure is deliberate: the whole model→plan path
is testable with fixture JSON and no browser, matching how
`buildRuntimeFaultsScript` / `compileRuntimeFaults` are tested today.

#### Oracle evaluation

The user supplies the bridge from page to model vocabulary — the same
`derive` shape `stateMachineInvariant` already takes:

```ts
await runPlan(plan, {
  baseUrl: "http://localhost:3000",
  // fires the modelled user action
  action: async (page) => { await page.getByRole("button", { name: "Load" }).click(); },
  // maps the page back to the model's `ui` label
  uiProbe: async (page): Promise<"idle" | "loading" | "done" | "error" | "stuck"> => { … },
  rules: { opA: /\/api\/a/, opB: /\/api\/b/ },   // model op → urlPattern
});
```

`expect.ui` is compared against `uiProbe`. `expect.unhandledRejection` is
compared against the run's `unhandled-rejection` errors, which the crawler
already collects and classifies (`crawler.ts:520 reclassifyRejections`,
`filters.ts:90`). One semantic addition: a plan whose oracle *expects* an
unhandled rejection passes when it occurs — so a model configured with a
known-missing handler documents the failure instead of failing the build.

#### Report

```ts
interface ModelCoverage {
  spec: string;
  statesTargeted: number;
  statesReached: number;
  statesUnreachableInBound: number;   // with the depth bound recorded
  depthBound: number;
  plansRun: number;
  mismatches: Array<{ plan: string; field: "ui" | "unhandledRejection"; expected: unknown; actual: unknown }>;
  /** Plans the model says reach different states but whose V8 coverage is identical. */
  collapsedPlans: Array<[string, string]>;
}
```

`mismatches` is the interesting output: a mismatch is either an app bug or a
wrong model, and both are findings worth a human.

#### CLI

```bash
# dev-time — needs Quint + JVM; writes committed artifacts
chaosbringer model enumerate --spec model/promise.qnt --targets model/targets.json \
  --max-steps 6 --out model/plans/

# CI — pure Node, no Quint
chaosbringer model run --plans model/plans/ --url http://localhost:3000 --config model/bridge.ts
```

#### V8 coverage cross-check

The model enumerates *model* states; it says nothing about implementation
coverage. `@mizchi/playwright-v8-coverage` closes that loop: record a coverage
fingerprint per plan, then report pairs of plans that the model calls distinct
states but that touch identical ranges (`collapsedPlans`). A collapse means the
model is over-refined *or* the app does not actually distinguish those cases —
both are review-worthy, and neither is visible from the model alone. This is
the piece that keeps the coverage claim honest.

## Data flow

Walking the `error_true` witness end to end (measured in the spike):

1. **Model** — `promise.qnt` describes two ops loaded for one action, with
   the intended contract (every rejection handled, every request bounded).
2. **Enumerate** — `quint verify --invariant='not(opState.get("cart") == "rejected"
   and opState.get("shipping") == "rejected")'` returns a counterexample in
   ~14 s: `start → reject(cart) → reject(shipping)`. The state the probability
   sweep reaches ~9% of the time is now a named, always-run test case.
3. **Compile** — ITF → `{ schedule: [ {cart,0,reject}, {shipping,0,reject} ],
   expect: { ui: "error", unhandledRejection: false } }`.
4. **Replay** — one `chaos()` run: both operations get a `reject-fetch` fault
   whose `schedule.decisions[0] = "inject"`, one click, one settle window.
5. **Verdict** — `uiProbe` returns `error` (matches), but the run records an
   `unhandled-rejection` while the contract forbids one → `mismatches` gets an
   entry naming plan, field, expected, actual. That is the report line the
   probability sweep never produced.

This is not hypothetical: it is what `examples/model-faults/` reports today.
The buggy variant of that app fails 13 of 16 plans (5 `ui`, 8
`unhandledRejection`); `FIXED=1` passes all 16.

## Testing strategy

**`playwright-faults` (pure, no browser):**

- `decideFault`: schedule vs probability precedence, `afterEnd` variants,
  out-of-range occurrence, both-set validation error.
- `buildRuntimeFaultsScript` with schedules: assert the emitted decision table
  is embedded and index-keyed (extends the existing script-shape tests).

**`chaosbringer/src/model` (pure, fixture-driven):**

- `itf.ts` against committed ITF fixtures from real `quint verify` output,
  including `#map`, `#tup`, and `mbt::*` shapes.
- `compilePlan`: witness → plan; barrier-ambiguity rejection; unknown rule id.
- `coverage.ts`: mismatch aggregation, collapsed-plan detection.

**Integration (browser):**

- A fixture app under `examples/model-faults/` with two endpoints and a
  deliberately missing second-rejection handler. Assert
  `model run` reports exactly one mismatch, then assert the fixed app reports
  zero. This is the end-to-end regression for the whole pipeline.
- `hang`: assert the run terminates and held routes are drained.

**Nightly (needs Quint + JVM):**

- Re-run `model enumerate` and diff against the committed plans. A diff means
  the model changed without regenerating — fail the nightly, not the PR.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **State explosion.** Ops × outcomes × interleavings blows up fast. | Model one user action, ≤4 ops, ≤6 steps. Cheap tier (`quint run --witnesses`) first; Apalache only for targets the simulator missed. Enumeration is dev-time, so cost is bounded by patience, not CI minutes. |
| **Apalache cost.** ~14 s per query measured, plus JVM startup. | Plans are committed build artifacts; CI never runs Quint. Nightly regenerates and diffs. |
| **Model/implementation gap.** Model coverage is not code coverage. | V8 coverage fingerprints + `collapsedPlans`. The report never claims implementation coverage. |
| **Microtask order is unenforceable.** A model can express interleavings the browser cannot reproduce → flaky plans. | Documented [determinism boundary](#determinism-boundary); compiler rejects barrier-ambiguous plans; one rule per logical op. |
| **`hang` wedging runs.** A never-settled route can block teardown. | Held-route registry drained on page close; `releaseAfterMs` escape hatch; held-route count on the report. |
| **Unhandled-rejection detection timing.** Rejections surface asynchronously; a short run can end before the event fires. | The oracle drains rejections at a settle barrier before verdict, reusing the existing `reclassifyRejections` drain point rather than adding a sleep. **Revised after shipping:** one barrier is not enough. A retry scheduled on the error path fires after it, so the run instruments `setTimeout` before the action, waits for the app's own pending timers, and classifies anything that escapes in that window as `unhandledRejection@late`. See the recipe's "A probe is an instant; a bug is not". |
| **A right label over a wrong page.** `expect.ui` is one word; a page can satisfy it while showing stale data with its primary action still enabled. | *Added after shipping:* per-label DOM invariants in the bridge (`uiInvariants`), checked as their own mismatch field. The model supplies the label; only the app knows what it promises. |
| **One-sided call counting.** The `injection` check only ever asked whether *too few* faults fired, and `matched` was collected and discarded. | *Added after shipping:* `matched` is kept per operation, `expect.calls` states a total, and `checkAmplification` compares against the schedule's span. Opt-in, because a model written for one action against a page that also fetches on mount legitimately makes more calls. |
| **Quint learning curve for contributors.** | Models live next to the app fixture with the commands in the README. Note the footgun found in the spike: `x' = a or b` parses as `(x' = a) or b` — assignments need parens around boolean right-hand sides, and the typechecker will not catch it. |

## Sequencing

Each phase is independently useful and independently shippable.

- **PR 1 — deterministic schedules.** `FaultDecision` / `FaultSchedule` /
  `decideFault` in `playwright-faults`; wire into `crawler.ts`, lifecycle,
  iframe, and the in-page runtime script; validation + tests. Ships value
  alone: hand-written deterministic scenarios ("fail the first call, pass the
  retry") become expressible, which is the single most-requested thing
  probability cannot express.
- **PR 2 — Promise-spec fault kinds.** `hang`, `reject-fetch`,
  `never-settle-fetch`, `reject-body`, `resolve-rejected-thenable`, held-route
  draining, `flaky-fetch` alias.
- **PR 3 — model pipeline.** `src/model/` (itf / plan / runner / coverage),
  `ModelCoverage` on the report, `chaosbringer model enumerate|run`,
  `examples/model-faults/` fixture app + the committed `promise.qnt`.
- **PR 4 — coverage cross-check + docs.** V8 fingerprints, `collapsedPlans`,
  `docs/recipes/model-driven-faults.md` (what it is, why) and a
  `docs/cookbook/` entry (copy-paste path), plus the nightly regenerate-and-diff
  workflow.

PR 1 and PR 2 are prerequisites for PR 3. PR 4 depends on PR 3.

## Appendix A — feasibility spike

Run on 2026-08-20 with Quint 0.32.0 (`--backend=typescript`; the Rust
evaluator wants a GitHub download) and Apalache 0.56.1 on OpenJDK 21. The
model, the enumeration script, and the ITF→plan compiler are committed under
[`2026-08-20-quint-spike/`](./2026-08-20-quint-spike/) so these numbers are
reproducible.

**Model** (`promise.qnt`, abridged — two ops folded by `Promise.all`):

```quint
pure val OPS = Set("A", "B")
var opState: str -> str     // unstarted | pending | fulfilled | rejected | hung
var ui: str                 // idle | loading | done | error | stuck
var unhandled: bool
var log: List[{ kind: str, op: str }]   // the injection plan, exported via ITF

pure val HAS_CATCH = true
pure val HAS_TIMEOUT = false

pure def expectedUi(s: str -> str): str =
  if (anyRejected(s)) "error"
  else if (allFulfilled(s)) "done"
  else if (anyHung(s)) (if (HAS_TIMEOUT) "error" else "stuck")
  else "loading"

action reject(op: str): bool = all {
  opState.get(op) == "pending",
  val nx = opState.set(op, "rejected")
  all {
    opState' = nx,
    ui' = expectedUi(nx),
    // Promise.all settles on the FIRST rejection; a second rejection has no
    // handler attached -> unhandledrejection. Parens are load-bearing.
    unhandled' = (unhandled or anyRejected(opState) or not(HAS_CATCH)),
    log' = log.append({ kind: "reject", op: op }),
  },
}
```

**Enumeration** over `ui × unhandled` (8 targets, depth bound 5):

```
REACHABLE    ui=loading unhandled=false   witness=1 step
UNREACHABLE  ui=loading unhandled=true
REACHABLE    ui=done    unhandled=false   witness=3 steps
UNREACHABLE  ui=done    unhandled=true
REACHABLE    ui=error   unhandled=false   witness=2 steps
REACHABLE    ui=error   unhandled=true    witness=3 steps   ← the target bug
REACHABLE    ui=stuck   unhandled=false   witness=2 steps
UNREACHABLE  ui=stuck   unhandled=true
```

**Compilation** — a 40-line pure function turned each ITF witness into the
`FaultPlan` shape above, e.g. for `error_true`:

```json
{ "name": "error_true",
  "schedule": [ { "rule": "A", "occurrence": 0, "outcome": "reject" },
                { "rule": "B", "occurrence": 0, "outcome": "reject" } ],
  "expect": { "ui": "error", "unhandledRejection": true },
  "modelSteps": 3 }
```

(The spike model was configured to *predict* the escaping rejection, hence
`unhandledRejection: true`; the shipping model asserts the intended contract
and reports the deviation as a mismatch instead.)

**Timings** — `quint verify` ≈ 14 s per target including JVM startup;
`quint run` with 500 random traces ≈ 0.3 s, which is why the simulator is the
pre-flight tier and Apalache only answers what the simulator missed.

Not covered by the spike, and therefore the real work of PR 1–3: nothing in
chaosbringer can replay a schedule yet.
