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
| "Cannot happen" | indistinguishable from "not seen" | reported as unreachable, with the depth bound — and classified `live` / `by-construction`, so a query with one possible answer does not read like a proof |
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

**"Unreachable" is only a result if a witness was possible.** These models are
written as "set every contract knob to what a correct implementation must do,
then the forbidden states are unreachable" — so a `contract-forbids-*` target
is worth its ~14s of Apalache only if *some* setting of those knobs produces a
witness. `not(attempts <= MAX_ATTEMPTS)` against
`attempts' = if (budgetSpent(attempts)) attempts else attempts + 1` restates
its own assignment: the query has one possible answer, and `targets.txt` used
to record it exactly like the ones that had two.

`examples/model-faults/patterns/vacuity.mjs` re-asks every such target against
a knob-inverted copy of the model (`quint run --witnesses`, ~3s per model, no
JVM) and each `enumerate.sh` calls it, so the row says which it was:

```
unreachable-live            contract-forbids-runaway
unreachable-by-construction contract-forbids-partial-page
```

A `by-construction` row is a prompt, not a failure: either give the model the
knob that makes the property falsifiable — that is what `BUDGETED` is for in
`reconnect.qnt`, and it turned all four of that pattern's targets live — or drop
the query and say why in the model's header. Do not leave a property claiming to
be checked when it cannot fail.

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

`rule` names an operation the bridge declares; `order` is the settlement order
the witness had. **`occurrence` is the count of that operation's calls, from
zero** — so a page that fetches on mount and again on click has the click as
occurrence *1*, and a plan aimed at the click but written as occurrence 0 fires
on page load instead. That off-by-one is the single most common way a plan
misses, and the models in this repo state their page-load reads explicitly for
exactly that reason.

`expect` has four fields, and a model states whichever ones it knows:

| field | compared against | when to use it |
|---|---|---|
| `ui` | the bridge's `uiProbe` | always — it is the model's terminal label |
| `unhandledRejection` | the run's classified rejections | always |
| `state` | the bridge's `stateProbe` | observables the UI does not show: write counts, refresh counts, rollback flags |
| `calls` | requests seen per operation | when the model knows an operation's *total* call count, page-load calls included — including an operation the schedule never pins, where `0` states that the endpoint is not touched at all |

`calls` exists because the schedule cannot say what must **not** happen. It
pins the outcome of call 0 and call 1; it has no way to state that call 2 does
not exist. `{ "calls": { "telemetry": 1 } }` does.

It also says what must happen where no fault can. Some calls an app owes the
user are not injection points at all — the extra read after an ambiguous
failure, for instance: the app has to ask the server what it actually
committed, and nothing about that read can be faulted, so no schedule step
describes it. The model counts it and states the total:

```bash
chaosbringer model compile --traces traces --out plans \
  --state-var committed --state-var shown \
  --calls-var list=listCalls
```

`--state-var` and `--calls-var` are not interchangeable, and the two can
disagree on purpose. `expect.state` is compared against the bridge's
`stateProbe`, so it can only carry things the page or its server can report
about themselves; "how many times was this endpoint called" is not one of
those, and is compared against what the fault layers counted. `token-refresh`
lifts both for the refresh endpoint — `refreshes` (what the server served,
read from `/api/refresh/count`) and `refreshCalls` (what the client issued) —
because a refresh whose 401 a plan injects is a request the client made and
the server never saw, and the load claim only survives on the second number.

That is also why a rule whose steps are all `pass` still gets a counting-only
route, and why one named *only* by `expect.calls` gets one too: without a route
there is no count to compare, so `{ "refresh": 0 }` — the strongest thing a
control plan says — would be accepted, typechecked and never checked. A bound
nobody applies is worse than no bound.

One rule about the rule, learned the hard way: **a `$`-anchored `urlPattern` on
an operation a plan counts is refused before the browser launches.** Everywhere
else the regex is a selector, and too narrow shows up as a missing injection.
Under `expect.calls` it *is* the number being asserted — `/\/api\/stream$/`
neither faults nor counts `/api/stream?cursor=…`, so a client that resumed 58
times reported exactly the 9 the model predicted. Write
`/\/api\/stream(\?|$)/`.

### What the model writes, and what it compiles to

Two vocabularies, and confusing them is the first thing that will stop you.
**Left column is what you write in the model.** The middle column is what
appears in the committed plan — you never type it — and the right column is how
the runner realises it.

| Model action (`kind` in the log) | Plan outcome | Realised as | Layer |
|---|---|---|---|
| `fulfil` / `fulfill` / `resolve` / `succeed` | `pass` | nothing injected | — |
| `reject` / `fail` | `reject` | `reject-fetch` (TypeError) | runtime |
| `abort` / `cancel` | `abort` | `reject-fetch` (DOMException `AbortError`) | runtime |
| `rejectBody` | `reject-body` | `res.json()` rejects after the fetch resolved | runtime |
| `hang` / `stall` | `hang` | `never-settle-fetch` | runtime |
| `status` / `serverError` | `status` | `faults.status(500)` | network |
| `slow` / `slowOk` | `slow-ok` | `faults.delay(<solved>)` — slow, inside the app's bound | network |
| `tooSlow` / `timeout` | `slow-trip` | `faults.delay(<solved>)` — past the bound *and* past the probe | network |

Anything else is an error at compile time rather than a silently dropped
injection — but note that three plan outcomes are *not* action names: `pass`,
`slow-ok` and `slow-trip` only ever appear in the compiled plan. Write `fulfil`,
`slow` and `tooSlow`.

### The model tells the compiler what it did

The compiler does not infer the schedule from state diffs — the model states it,
in a log variable:

```quint
var log: List[{ kind: str, op: str }]
```

`kind` is an action name from the table above; `op` is the operation id, which
must match a key of the bridge's `rules`. Append one entry per settlement:

```quint
action reject = all {
  // …the rest of the transition…
  log' = log.append({ kind: "reject", op: "cart" }),
}
```

An action that is app behaviour rather than an injection — a token refresh the
app performs on its own — logs nothing and is named in `--ignore-action`. The
variable name, the two field names and the state/UI variables are all
overridable (`--log-var`, `--ui-var`, `--unhandled-var`); the defaults above are
what every model in this repo uses.

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

  // Observables the UI does not show: write counts, refresh counts, rendered
  // revisions. Required by any plan that names `expect.state` — without it the
  // runner reports the expectation as unchecked rather than passing it, because
  // an unchecked expectation is worse than none.
  stateProbe: async (page) =>
    page.evaluate(async () => {
      const res = await fetch(`/api/orders/count?session=${window.__SESSION__}`);
      return { orders: (await res.json()).orders };
    }),

  settleMs: 1600,
};
```

Two things about `stateProbe` that cost time to learn the hard way. Its own
requests must not match any rule in `rules`, or the probe is counted as an
operation and `expect.calls` becomes unassertable — anchor the patterns, and
give the probe its own endpoint. And an endpoint that *changes* what it
measures (a read that bumps a revision, say) makes the probe part of the
experiment; keep a side-effect-free reader for it.

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
| `ui@late` | the page reported the predicted label *and then moved off it* during the observation window — the `Promise.race` "timeout" that bounds the banner and cancels nothing |
| `uiInvariant` | the page reported the predicted label while breaking what that label promises (a `uiInvariants` entry returned a message) |
| `uiInvariant@late` | the same invariant held at the probe and stopped holding during the window |
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

Count always, require only when nothing was injected: those are two separate
decisions, and conflating them is how `expect.calls` was briefly unenforceable
on exactly the operations that needed it.

### A probe is an instant; a bug is not

Two of those fields exist because the run used to end at the probe. A retry
scheduled on the error path, and a backend that acknowledges a write now and
commits it later, both land after it:

```
action ──── settleMs ────▶ probe: ui, uiInvariants, state
                             │
                             ├── drain the timers the app scheduled itself
                             ├── quiescenceMs (when a plan names state, or a
                             │                 ui label the page could move off)
                             ▼
                           second read: state, ui, uiInvariants;
                           late-rejection classification
```

- The runner instruments `setTimeout` / `setInterval` **before** firing the
  action, so it knows whether the page has work due in the future and how far
  out, and waits for it (default cap `asyncDrainCapMs: 3000`). A `void retry()`
  inside a 900ms backoff escapes every handler; a run that stopped at 400ms
  reported `unhandledRejection: false` and was neither wrong nor right — it had
  not looked. Recurring timers are *reported*, never waited on: an uncleared
  `setInterval` is a fact about the app, not a reason to hang.
- `expect.state` is compared against a **second** read, taken after
  `quiescenceMs`. The window is spent by any plan the second look could change
  its mind about — one naming `expect.state`, or a `ui` label, or a bridge with
  `uiInvariants` — which in practice is nearly every plan. Set
  `quiescenceMs: 0` to opt a suite out, and read the cost table below first: on
  this repo's example suite the window is ~25s of the 135s.
- A read that disagrees with itself is named in the failure detail, so the
  report says *the probe read the value the model predicted, and something else
  afterwards* rather than looking like a flake. A read that started wrong and
  converged on the prediction is **not** reported: a 202-Accepted backend that
  commits late is not a bug, and failing that would make every queue-backed API
  flake.
- `ui` and `uiInvariants` get the **symmetric** second look, under the same
  soundness rule. A label that started wrong and converged is a page catching
  up (the convergence goes in the `ui` detail, not into a second mismatch); a
  label that started *right* and moved is `ui@late`. That is the whole shape of
  a `Promise.race` "timeout": the banner says the report failed on schedule,
  and 400ms later the report is on screen — from a request the app believes it
  abandoned, which reached the server and consumed its work. The window is
  only spent where it can pay: a plan that names no `ui` label and no state
  observable, against a bridge with no invariants, pays nothing.

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
- **A probe the app parameterises.** An `expect.state` probe that asks the app
  *which bucket to read* can be lied to by the app. `retry-idempotency` reads
  `/api/orders/count?session=window.__SESSION__` — the same value the page
  sends as `x-session` — so the assertion is not "the server holds one order",
  it is "the server holds one order in the bucket this page named". A client
  that re-mints its session between attempts (a re-auth, a new client id, a
  per-attempt tenant header) files the second write somewhere else, and the
  probe reads the 1 the model predicted while the server holds 2. Both reads
  agree, so the settled-read drift detail does not fire either: the value is
  stable and wrong. The fix is not a smaller probe but a differently scoped
  one — a server-side ledger scoped to the *run* rather than to a value the
  page chose (`examples/model-faults/redteam/server.ts`'s `allSessions()` is
  that shape) — and until the app under test exposes one, a bridge whose probe
  reads a count should prefer the total to a slice. It is narrow: it needs the
  write's scoping key to change between attempts. It is also the one place
  where a passing `expect.state` proves nothing at all.
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

An app that **retries** needs one more line, because `appDeadlineMs` describes
one request and the app's terminal state is several away:

```js
export default {
  appDeadlineMs: 500,                              // one bounded attempt
  appLadder: { attempts: 3, backoffsMs: [60, 120] },  // …climbed three times
  settleMs: 1800,          // declared, and validated against the ladder
  timingProfile,
};
```

`settleMs` and `appDeadlineMs` are not exclusive: declaring both is how an
author who knows their app retries states the window while still getting solved
`slow-ok` / `slow-trip` values. The ladder only *validates* — solving it would
put a window nobody asked for on every plan — and the error names the number to
write. Note the tripping delay is re-derived from the declared window rather
than the solved one: `slow_outlasts_probe` is a statement about the probe
instant, and a delay solved for a 531ms probe lands mid-window when the author
declared 1800ms, where an unbounded app reads as healthy.

What the solver derives, and why each one matters:

| value | rule | what goes wrong without it |
|---|---|---|
| `settleMs` | `>= deadline + tightTail + margin` | a probe that fires before the app's own deadline reports a correctly-bounded request as `stuck` |
| `slow-ok` delay | `<= deadline − delayTail − margin` | jitter pushes a "tolerable" delay past the deadline and the plan flakes |
| `slow-trip` delay | `>= settleMs + margin − floor` | against an app with *no* bound the response still arrives; landing mid-probe, it reads as healthy |
| `quiescenceMs` | `>= deadline + tightTail + margin` | the run stops watching before the retry the app scheduled on the error path has run, so `unhandledRejection: false` describes a page nobody looked at |
| `releaseMs` | `>= settleMs + margin` | a hang released before the probe is not observable as a hang |
| `pageTimeout` | `>= fixed + settleMs + delayTail + margin` | the crawler kills the run mid-probe |
| `settleMs`, when the bridge declares `appLadder` | `>= attempts × (deadline + tightTail + margin) + Σ backoffs` | `deadline` describes one request; a client that retries three times reaches its terminal state three rounds later, and a window solved for one of them reports a correctly budgeted client as an endless spinner |

Infeasible is a first-class answer. A deadline smaller than the machine's own
jitter cannot be tested at all, and the solver says so with the number to fix:

```
no expressible delay is tolerable under a 120ms deadline: this environment's
jitter is 122ms (measured × safety 2) and its floor is 4ms, so even the smallest
injectable delay can be observed at 126ms. Raise the deadline above 151ms, lower
the safety factor if your calibration is trustworthy, or stop asserting on
timing at this scale.
```

The `× safety` clause is the part to read: the shipped profile is already
pessimistic and the solver multiplies it again, so an infeasible answer is
sometimes the *safety factor* talking rather than the machine. All three levers
the message names are reachable from a bridge — `safety: 1` uses the measurement
rather than twice it — but spend that one only against a profile measured under
the load the run will actually see. `safety` stands in for the gap between a warm
calibration and a busy machine, so trading it away on a warm profile buys flakes
rather than speed.

Two facts about the measurement, in more detail in
[the solver's notes](../superpowers/specs/2026-08-20-timing-solver/):

- **Deadlines are exact, injected delays are not.** `AbortSignal.timeout` fired
  within 3ms of nominal; an injected delay overshot by up to 107ms on a cold
  run. Delay-side separations therefore need far more margin than probe-side
  ones — an asymmetry no hand-picked constant encodes, and the reason the
  solver treats the two directions differently.
- **A profile measured on an idle machine is not a bound on a loaded one, and
  the probe side is where that bites.** An earlier version of this page quoted
  ~5ms as the probe-side requirement, from a warm calibration. Under real
  single-core contention a `page.waitForTimeout(settleMs)` overshoots that
  easily, and a tripping delay solved to land just after the probe lands
  *before* it instead — so an app with no bound at all reads healthy, which is
  the one verdict a timing plan must never produce. Calibrate under the load
  your CI actually has, and treat a probe-side tail measured warm as optimistic.
  `calibrate` warns when it thinks that happened; believe it.

## Determinism boundary

What is enforceable: each operation's **outcome**, and per-operation
occurrence order (the app issues call 0 before call 1).

What is not: the order in which two *different* concurrent operations settle,
and microtask interleaving inside the page. There is no browser hook for
either, and patching `Promise.prototype.then` would change the semantics under
test.

So plans that inject the same multiset of outcomes but predict *different*
results are flagged `orderSensitive` at compile time and skipped by the runner
rather than run as a coin flip.

Skipped is not quietly tolerated, and it is worth being clear about that
because "skipped" usually means "ignored": `modelRunPassed` requires
`plansSkipped === 0`, so `model run` **exits 1** and your suite goes red. That
is deliberate — a plan whose verdict would be a coin flip is not a plan you
should be able to commit and forget — but it means there is no "known
unenforceable, tracked" state. If you hit it, the fix is on the model side:
either it over-specifies (an ordering assumption it never states) or the
operations belong in separate rules. `--allow-order-sensitive` runs them
anyway, and exists for one case only: finding out *whether* the ordering is
what your app actually depends on, before you go back and change the model.

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
| `node patterns/vacuity.mjs` (all seven models) | ~21s, no JVM | Quint |
| …plus, for a plan naming `expect.state` or an `expect.ui` label | one `quiescenceMs` window | — |
| …plus, on a page with pending timers | up to `asyncDrainCapMs` (3s) | — |

Enumerate at dev time or in a scheduled job, commit the plans, and re-check the
regenerated output against them so a model change that nobody recompiled is
caught there rather than silently leaving the plans stale.

Two things that check cannot be. It cannot be `git diff`: ITF traces carry a
"Created by Apalache on <timestamp>" line, and the solver may return a
different-but-equivalent witness for the same target — both make a regeneration
look dirty when nothing changed. Compare what matters instead, per state: the
set of (operation, occurrence, outcome) injections and the oracle
(`examples/model-faults/model/check-plans.mjs` does exactly that, and every
example shares it).

And it cannot be a hand-maintained list of what to check. The unit is a *model
directory* — anything carrying the `enumerate.sh` + `compile.sh` + `plans/`
triple — discovered by globbing for it, because a model nobody added to the list
is a model nobody regenerates and it looks exactly like a green run. One CI leg
per unit also keeps them parallel: eight units today, the slowest ~2 minutes,
where a loop over them was already at 5m43s with three.

## Scaling guidance

Model **one user action** with ≤4 operations and ≤6 steps. The 4×4 grid in the
example is 16 targets, ~4 minutes to enumerate once and ~40 seconds to replay.
The six patterns in `examples/model-faults/patterns/` are each 3–7 targets,
which is the size a real pattern wants: one action, one contract, and the grid
that makes its interleavings appear.
A 6-operation model with 5 outcomes each is 15 625 targets — that is not a
coverage plan, it is a hang.

## See also

- [`examples/model-faults/`](../../examples/model-faults/) — runnable: buggy
  variant fails 13 of 16 plans, `FIXED=1` passes all 16.
- [`examples/model-faults/patterns/`](../../examples/model-faults/patterns/) —
  six real-world async shapes, each a model of what a correct implementation
  must do plus the bug class it catches. Useful as a map of which oracle field
  earns its keep where: a double write needs `expect.state`, a reconnect storm
  needs `expect.calls` and has no state at all, and an out-of-order render needs
  `uiInvariants` because prompt and slow predict byte-identical oracles.
- [`examples/model-faults/redteam/`](../../examples/model-faults/redteam/) —
  one app per blind spot the oracle used to have, each in a buggy and a
  corrected variant. `attack.mts` asserts that the buggy one now fails and the
  corrected one still passes; `guardwalk.mts` pushes each check from the other
  side, on apps that are correct.
- [Deterministic fault schedules](../cookbook/deterministic-schedules.md) —
  the `schedule` primitive on its own, without a model.
- [Design doc](../superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md)
  — why it is shaped this way, and what was deliberately left out.
