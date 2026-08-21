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

`expect` has four fields, and a model states whichever ones it knows:

| field | compared against | when to use it |
|---|---|---|
| `ui` | the bridge's `uiProbe` | always — it is the model's terminal label |
| `unhandledRejection` | the run's classified rejections | always |
| `state` | the bridge's `stateProbe` | observables the UI does not show: write counts, refresh counts, rollback flags |
| `calls` | requests seen per operation | when the model knows an operation's *total* call count, page-load calls included |

`calls` exists because the schedule cannot say what must **not** happen. It
pins the outcome of call 0 and call 1; it has no way to state that call 2 does
not exist. `{ "calls": { "telemetry": 1 } }` does.

Outcomes are model-level, and the runner maps them onto fault kinds:

| Outcome | Realised as | Layer |
|---|---|---|
| `pass` | nothing injected | — |
| `reject` | `reject-fetch` (TypeError) | runtime |
| `abort` | `reject-fetch` (DOMException `AbortError`) | runtime |
| `reject-body` | `reject-body` (`res.json()` rejects) | runtime |
| `hang` | `never-settle-fetch` | runtime |
| `status` | `faults.status(500)` | network |
| `slow-ok` | `faults.delay(<solved>)` — slow, still inside the app's bound | network |
| `slow-trip` | `faults.delay(<solved>)` — past the bound *and* past the probe | network |

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

  // What each label *promises* about the page. The model supplies the label;
  // only the app knows what it means, and a right label over a wrong page is
  // otherwise indistinguishable from a pass. Return a message to fail.
  uiInvariants: {
    error: async (page) =>
      page.evaluate(() => {
        const problems = [];
        if (document.getElementById("summary").textContent.trim() !== "") {
          problems.push("#summary still shows the previous order");
        }
        if (!document.getElementById("pay").disabled) problems.push("#pay is still enabled");
        return problems.join("; ");
      }),
    // "*" runs for every label.
  },

  settleMs: 1600,
};
```

`uiInvariants` is where an app's own consistency rules go, once, instead of
being restated in every plan. It is the cheapest closure for the largest class
of these bugs: a failed price refresh that swaps the banner and leaves the
stale total on screen with the submit button enabled reports `error` exactly as
the model predicted, and a \$80 charge submitted from that page reaches the
backend. The label was never wrong; what the label promised was.

## What the runner checks

| field | what it catches |
|---|---|
| `ui` | the page ended somewhere the model did not predict |
| `uiInvariant` | the page reported the predicted label while breaking what that label promises (a `uiInvariants` entry returned a message) |
| `unhandledRejection` | a rejection escaped every handler when the contract forbids it — or failed to escape when the model predicts one |
| `unhandledRejection@late` | the same, but it escaped only *after* the probe, from work the app scheduled itself |
| `state` | an observable the model named came out wrong, read once the run had settled |
| `injection` | a planned fault never fired, so the state was not actually exercised — *including* an all-`pass` plan whose operation the app never called |
| `amplification` | the app called an operation more often than the model described (`expect.calls`, or the opt-in span comparison) |

`injection` is the one that keeps the coverage claim honest: without it a plan
whose request the app never issues looks like a pass. Note that it now covers
plans that inject *nothing*. An all-`pass` schedule is every model's happy
path, and until it had to be observed, a page that served a cache and never
revalidated satisfied it by doing nothing at all — while the report counted the
state as reached.

The requirement is deliberately limited to plans whose schedule is entirely
`pass`. In a plan that injects something, an injected failure can legitimately
stop the app from issuing a later request — `await a; await b` never reaches
`b` — so demanding that `b` was called would flag the model's own prediction as
a bug. A plan that does know an operation's totals says so with `expect.calls`.

### A probe is an instant; a bug is not

Two of those fields exist because the run used to end at the probe. A retry
scheduled on the error path, and a backend that acknowledges a write now and
commits it later, both land after it:

```
action ──── settleMs ────▶ probe: ui, uiInvariants, state
                             │
                             ├── drain the timers the app scheduled itself
                             ├── quiescenceMs (only when a plan names state)
                             ▼
                           second state read, late-rejection classification
```

- The runner instruments `setTimeout` / `setInterval` **before** firing the
  action, so it knows whether the page has work due in the future and how far
  out, and waits for it (default cap `asyncDrainCapMs: 3000`). A `void retry()`
  inside a 900ms backoff escapes every handler; a run that stopped at 400ms
  reported `unhandledRejection: false` and was neither wrong nor right — it had
  not looked. Recurring timers are *reported*, never waited on: an uncleared
  `setInterval` is a fact about the app, not a reason to hang.
- `expect.state` is compared against a **second** read, taken after
  `quiescenceMs`. The window is only spent when a plan actually names state
  observables, so a suite of label-only plans pays nothing for it.
- A read that disagrees with itself is named in the failure detail, so the
  report says *the probe read the value the model predicted, and something else
  afterwards* rather than looking like a flake. A read that started wrong and
  converged on the prediction is **not** reported: a 202-Accepted backend that
  commits late is not a bug, and failing that would make every queue-backed API
  flake.

Amplification is opt-in per bridge (`checkAmplification: true`) precisely
because it is not sound by default. The span comparison asks "did the app make
more calls than the schedule describes", and a model written for one user
action against a page that also fetches on mount legitimately makes more —
`examples/model-faults/redteam/guardwalk.mts` case 1 is that false positive,
run on purpose. `expect.calls` carries no such caveat and is always checked:
there, the count is the model talking.

## What the oracle still cannot see

Stated plainly, because an honest boundary is worth more than an implied
guarantee.

- **Response attribution.** The oracle cannot name *which response's body* must
  be on screen. `expect.ui` is a label; `uiInvariants` can only check what the
  app itself exposes. An app that renders `#shown[data-q]` alongside its results
  can have "the results belong to the query in the box" checked; an app that
  renders a bare string cannot, and a stale response that overwrites a newer one
  will read as a clean `ready`. Emitting a request-generation marker into the
  DOM is a small change to the app and the only thing that makes the bug
  observable from outside.
- **Purely local async.** There is no fault kind for a `setTimeout` chain, a
  `queueMicrotask`, or a `visibilitychange` handler, so no plan can target one.
  The runner can now *wait* for local timers, which is why a rejection escaping
  from one is caught — but it cannot make one fail, so a bug reachable only by
  perturbing local scheduling has nothing to write a plan against.
- **Work past the observation window.** `quiescenceMs` bounds one further round
  of app-deadline-length work, and the timer drain follows at most four rounds
  of chained timers within `asyncDrainCapMs`. A duplicate write that commits
  five seconds later, or a retry ladder with a 30-second backoff, is outside
  it. The window is a derived heuristic, not a proof of quiescence: what is
  still pending when the run ends is reported in
  `observed.pendingAsync` rather than silently dropped.
- **Cross-operation settlement order.** Unchanged, and still the hard limit —
  see [Determinism boundary](#determinism-boundary).
- **Non-fetch transports.** A `reject` outcome patches `fetch`, so an
  `XMLHttpRequest` app never sees it. That is reported honestly rather than
  silently: the fault does not fire, `injection` fails, and the plan lands in
  `plansNotExercised`. It is a coverage gap, not a false pass.

## Timing is solved, not guessed

`slow-ok` and `slow-trip` carry no millisecond value, because the right value
depends on the machine. Give the runner the app's own bound and a measured
profile, and it solves the rest:

```bash
chaosbringer model calibrate --url http://localhost:3000 --runs 3 --out model/profile.json
```

```js
// bridge.mjs — no settleMs, no delay constants
export default {
  appDeadlineMs: 700,       // must match the app's own AbortSignal.timeout
  timingProfile: JSON.parse(readFileSync(new URL("./profile.json", import.meta.url), "utf8")),
  // …rules / action / uiProbe
};
```

What the solver derives, and why each one matters:

| value | rule | what goes wrong without it |
|---|---|---|
| `settleMs` | `>= deadline + tightTail + margin` | a probe that fires before the app's own deadline reports a correctly-bounded request as `stuck` |
| `slow-ok` delay | `<= deadline − delayTail − margin` | jitter pushes a "tolerable" delay past the deadline and the plan flakes |
| `slow-trip` delay | `>= settleMs + margin − floor` | against an app with *no* bound the response still arrives; landing mid-probe, it reads as healthy |
| `quiescenceMs` | `>= deadline + tightTail + margin` | the run stops watching before the retry the app scheduled on the error path has run, so `unhandledRejection: false` describes a page nobody looked at |
| `releaseMs` | `>= settleMs + margin` | a hang released before the probe is not observable as a hang |
| `pageTimeout` | `>= fixed + settleMs + delayTail + margin` | the crawler kills the run mid-probe |

Infeasible is a first-class answer. A deadline smaller than the machine's own
jitter cannot be tested at all, and the solver says so with the number to fix:

```
no expressible delay is tolerable under a 120ms deadline: this environment's
jitter is 118ms and its floor is 4ms, so even the smallest injectable delay can
be observed at 122ms. Raise the deadline above 147ms […]
```

Two measured facts worth internalising, from
[the solver's notes](../superpowers/specs/2026-08-20-timing-solver/):

- **Deadlines are exact, injected delays are not.** `AbortSignal.timeout` fired
  within 3ms of nominal; an injected delay overshot by up to 107ms on a cold
  run. So delay-side separations need ~120ms of margin and probe-side ones
  need ~5ms — an asymmetry no hand-picked constant encodes.
- **The margin is load-bearing.** A delay 133ms closer to the deadline than the
  solved one misclassified 2 of 15 trials unthrottled, 4 of 15 under 4× CPU
  throttle. The solved value held 15/15 in both.

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

## Applied to an app that already existed

`examples/model-faults/` is purpose-built for this pipeline, which makes it a
weak proof. `examples/cloudflare-worker/` is not: it is a todo app written
months earlier for the server-fault-correlation demo. A model was written
against its "add a todo" flow without touching the app, and the first run
reported four findings — all in the write path, none in the read path (its
`refresh()` was already correctly guarded):

| Plan | What the app did | Why |
|---|---|---|
| `write-rejected__no-refresh` | `unhandledrejection`, list unchanged | the `click` listener was `async` with no `try`/`catch`: a failed POST escaped, and the stale list told the user it had saved |
| `write-errored__no-refresh` | rendered as success | `r.ok` was never checked, so a 500 refreshed the list as if the write worked |
| `write-hung__no-refresh` | rendered as success | nothing bounded the POST |
| (harness, not the app) | false `stuck` | `settleMs` was shorter than the app's own deadline, so the probe judged a bounded request as hung |

Two lessons went straight back into the tooling:

- **One URL can host two operations.** `GET /api/todos` and `POST /api/todos`
  are different operations, so `rules` accepts `{ urlPattern, methods }` and
  runtime faults gained a method filter. Without it a plan fires on whichever
  call arrives first.
- **A hung request must still reject when the caller cancels it.**
  `never-settle-fetch` honours `init.signal`, so an app that bounds its
  requests with `AbortController` / `AbortSignal.timeout` survives the fault
  and only one that *cannot* cancel is left hanging. Otherwise the fault would
  report correct code as broken.

Model the *contract*, not the implementation, and account for what the page
does on load: the app fetches its list once at load, so the post-click refresh
is occurrence **1** of that rule, not 0. The model states the page-load fetch
explicitly for exactly that reason.

## Cost and where it runs

| Step | Cost | Needs |
|---|---|---|
| `quint run --witnesses` | ~0.3s / 500 traces | Quint |
| `quint verify` (one target) | ~14s incl. JVM start | Quint + JVM |
| `model compile` | milliseconds | Node |
| `model run` (per plan) | ~2s (one browser, one action) | Node + Chromium |
| …plus, for a plan naming `expect.state` | one `quiescenceMs` window | — |
| …plus, on a page with pending timers | up to `asyncDrainCapMs` (3s) | — |

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
- [`examples/model-faults/redteam/`](../../examples/model-faults/redteam/) —
  one app per blind spot the oracle used to have, each in a buggy and a
  corrected variant. `attack.mts` asserts that the buggy one now fails and the
  corrected one still passes; `guardwalk.mts` pushes each check from the other
  side, on apps that are correct.
- [Deterministic fault schedules](../cookbook/deterministic-schedules.md) —
  the `schedule` primitive on its own, without a model.
- [Design doc](../superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md)
  — why it is shaped this way, and what was deliberately left out.
