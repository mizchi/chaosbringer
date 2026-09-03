# Model-driven faults: enumerate the failure space

The claim this buys you: "these N states were exercised, these M are
unreachable within depth k, nothing else exists in the model." A probability
sweep cannot say that — after a run it knows what fired, never what was never
attempted.

The cost: a model, a model checker at dev time, and about six conventions that
are cheap to follow and expensive to discover. They are all below.

```
model.qnt ──quint verify──▶ ITF traces ──model compile──▶ plans/*.json
 (the spec)  one witness per     (JSON)      (committed)        │
             target state                                       │ model run
                                                                ▼
                                     deterministic replay + oracle check
```

Only the last arrow runs in CI. Plans are committed artifacts, so CI needs
neither Quint nor a JVM.

## The two vocabularies — get this wrong and nothing compiles

There is what you write **in the model**, and what appears **in the plan**. They
are different words and confusing them is the first thing that will stop you.

| Write this in the model (`kind`) | Compiles to | Realised as |
|---|---|---|
| `fulfil` / `fulfill` / `resolve` / `succeed` | `pass` | nothing injected |
| `reject` / `fail` | `reject` | `fetch()` rejects (TypeError) |
| `abort` / `cancel` | `abort` | rejects with `AbortError` |
| `rejectBody` | `reject-body` | `res.json()` rejects |
| `hang` / `stall` | `hang` | never settles |
| `status` / `serverError` | `status` | a 500 from the route layer |
| `slow` / `slowOk` | `slow-ok` | a delay inside the app's bound |
| `tooSlow` / `timeout` | `slow-trip` | a delay past the bound *and* past the probe |

`pass`, `slow-ok` and `slow-trip` are **not** action names — they only ever
appear in the compiled plan. An unmapped action is a compile error, not a
silently dropped injection.

## The model states what it did

The compiler does not infer anything from state diffs. The model logs it:

```quint
var log: List[{ kind: str, op: str }]

action reject = all {
  // …the rest of the transition…
  log' = log.append({ kind: "reject", op: "cart" }),
}
```

`kind` is from the table above; `op` must match a key of the bridge's `rules`.
An action that is the app's own behaviour rather than an injection (a token
refresh the app performs itself) logs nothing and is named in `--ignore-action`.

Two Quint footguns worth knowing before you hit them:

- `x' = a or b` parses as `(x' = a) or b`. Parenthesise the right-hand side of
  any assignment whose value is a boolean expression. The typechecker will not
  catch it and the model will quietly do something else.
- `next` is reserved.

## `occurrence` counts from zero, and page load is usually zero

A plan step names an operation and *which call* of it to break. A page that
fetches on mount and again on click has the click as occurrence **1**. A plan
aimed at the click but written as occurrence 0 fires on page load instead, which
is the single most common way a plan misses. Models in this repo state their
page-load reads explicitly for exactly that reason.

## The bridge carries what the model cannot know

```js
// model/bridge.mjs
export default {
  rules: {
    // Anchor these. A pattern that also matches your state probe's own
    // requests makes `expect.calls` unassertable, and a `$`-anchored pattern
    // on a counted rule silently excludes every URL carrying a query string.
    cart: { urlPattern: /\/api\/cart(\?|$)/, methods: ["GET"] },
  },
  action: async (page) => page.getByRole("button", { name: "Load" }).click(),
  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },
  stateProbe: async (page) => /* observables the UI does not show */ ({ orders: 0 }),
  uiInvariants: {
    // What each label *promises* about the page. "*" runs for every label.
    error: async (page) => page.evaluate(() => /* return a message to fail */ ""),
  },
  appDeadlineMs: 700,   // must match the app's own AbortSignal.timeout
  timingProfile,        // from `chaosbringer model calibrate`
};
```

`stateProbe` is required by any plan naming `expect.state` — without it the
runner reports the expectation as unchecked rather than passing it, because an
unchecked expectation is worse than none. Two things about it:

- **Its own requests must not match any rule**, or the probe is counted as an
  operation. Give it a separate endpoint.
- **It must not change what it measures.** A read that bumps a revision makes
  the probe part of the experiment.

## A plan is a JSON file, and you can write one by hand

You do not need Quint or a JVM to use the replay side. Enumeration produces
these; writing three of them yourself is a reasonable way to start, and the
runner treats hand-written and generated plans identically.

```json
{
  "name": "report-unbounded",
  "schedule": [
    { "order": 0, "rule": "report", "outcome": "slow-trip", "occurrence": 0 }
  ],
  "expect": { "ui": "error", "calls": { "report": 1 } }
}
```

The field names are worth reading twice, because the prose around them uses
different words:

- the array is **`schedule`**, not "steps";
- each entry names the bridge's operation with **`rule`**, not `op` — even
  though everything here calls it an *operation* and `--calls-var` takes
  `<op>=<var>`;
- `order` is the position in the model trace (0-based), `occurrence` is which
  call of that same rule this step targets (0-based, per rule);
- `expect` holds the oracle: `ui`, `state`, `calls`, `unhandledRejection`.

Optional on the plan: `spec` and `modelSteps` (provenance, informational) and
`orderSensitive` (set when the outcome depends on the order two *different*
operations settle — the runner refuses those by default rather than producing
a flaky verdict, and exits 1).

`outcome` is one of `pass`, `reject`, `abort`, `reject-body`, `hang`, `status`,
`slow-ok` (slow but inside the app's bound — it must still succeed) or
`slow-trip` (slow past the bound — the app must give up and say so). The two
`slow-*` outcomes carry **no milliseconds**: you declare the app's own deadline
in the bridge and the harness solves the delays, which is what keeps a
committed plan portable between a laptop and CI.

`validatePlan` is exported and will tell you exactly which field it dislikes —
faster than guessing.

## What a plan can assert

| field | compared against |
|---|---|
| `ui` | `uiProbe` — the model's terminal label |
| `unhandledRejection` | rejections the run classified |
| `state` | `stateProbe`, read after the run settled |
| `calls` | requests the fault layers counted, page-load calls included |

An expectation whose probe the bridge does not supply is reported, not skipped:
`expect.ui` against a bridge with no `uiProbe` fails the plan as `undecided`,
and `expect.state` without a `stateProbe` fails as `state`. A probe-less bridge
is fine — stating an expectation it cannot read is what is not, because a check
that reads nothing passes for the wrong reason.

`calls` is the only one that can say what must **not** happen: the schedule pins
the outcome of call 0 and call 1 and has no way to state that call 2 does not
exist. It also states calls no fault can target — the extra read an app owes you
after an ambiguous failure.

Lift the last two from the model at compile time:

```bash
chaosbringer model compile --traces traces --out plans \
  --state-var orders --calls-var order=orderCalls
```

## `uiInvariants` is keyed by the label the page reported

Not the one the plan predicted. That is the useful way round — an invariant
fires against whatever state the app actually reached, so a label no plan
predicts (`"stuck"`, say) still gets checked — but it surprises people writing
their first bridge, who key their invariants by the predicted label and see
them never run. `"*"` applies to every label.

## What the runner reports

Eleven mismatch fields. The ones whose meaning is easy to guess wrong:

- `injection` — a planned fault never fired, *or* an `expect.calls` count the app
  came in **under**. Either way the state was not exercised.
- `amplification` — the app called an operation **more** often than described.
  Over-counts only.
- `ui@late` / `uiInvariant@late` / `unhandledRejection@late` — held at the probe,
  stopped holding afterwards. A label that started *wrong* and converged is a
  page catching up and is not reported.
- `probeError` — your bridge threw. Reported *instead of* everything else,
  because nothing observed after a thrown action is evidence.
- `undecided` — the probe fired too late to tell a bounded app from an unbounded
  one. Not a pass and not a failure: a refusal to answer. If frequent,
  re-calibrate under the load you actually have.

## Shrinking a counterexample

A checker hands you whichever counterexample its search reached first. A
twelve-step schedule where two steps matter is a normal output, and the reader
cannot tell which two.

```bash
chaosbringer model shrink --plan plans/refresh-storm.plan.json \
  --url http://localhost:3000 --config bridge.mjs --out min.plan.json
```

It drops steps that do not matter (delta debugging over the schedule), weakens
outcomes that do not need to be that strong (`hang` → `status` is a simpler
claim about your app), and lowers occurrences that do not need to be that late
(`occurrence: 3` → `0` is "it fails on the first call"). Every candidate is a
real run judged by the same oracle, so the minimum provably still fails.

Four things worth knowing before you read its output:

- **Contracts shrink; predictions do not.** `expect` is what the *model*
  predicted for *that* schedule, and shrinking cannot recompute it — weaken
  every step to `pass` and `expect.ui: "error"` still "fails", against an app
  behaving perfectly. So only contract findings are shrinkable: an escaping
  rejection (needs `expect.unhandledRejection: false`) and a `uiInvariant`
  violation. `ui`, `state`, `injection` and `amplification` exit 1 with
  `schedule-relative`; minimise the model instead. A plan with one of each is
  shrunk against the contract, and the output names what the minimum does not
  cover.
- **It preserves the *same* failure, not any failure.** The fields the first run
  reported become the target; a candidate that breaks differently is a different
  finding and is rejected. `--target unhandledRejection` narrows that when one
  plan trips several checks and you care about one.
- **`undecided` and `probeError` are neither "still fails" nor "fixed".** A
  candidate the oracle could not judge is retried, and if it stays undecidable
  the search stops and says so rather than voting — either vote is wrong, and a
  wrong vote silently moves the reported minimum.
- **It exits 0 only when it finished.** `budget` (ran out of runs, default 100)
  and `inconclusive` exit 1 with the reason. A minimum nobody established is not
  a minimum, so do not wire the exit code as "shrink succeeded" without reading
  `stop`.

`shrinkPlan` is exported if you want the search without the CLI; pass a `run`
function and it never touches a browser itself.

## Enumerating

To reach a state, ask the checker to prove it *unreachable* and keep the
counterexample:

```bash
quint verify model.qnt --max-steps=4 \
  --invariant='not(opState.get("cart") == "rejected")' \
  --out-itf=traces/cart-rejected.itf.json
# exit != 0 → counterexample written → reachable, and that trace IS the test
# exit == 0 → no witness within 4 steps → unreachable, and worth recording
```

Two practical notes: `quint verify` needs a JVM (Apalache) and costs ~7-14s per
query, and `quint run` needs `--backend=typescript` in sandboxed environments
where the Rust evaluator cannot be downloaded.

Also enumerate the states your contract **forbids** — they should come back
unreachable, and a witness there means the spec is wrong rather than the app.
But check that such a query *could* have failed: a predicate that restates the
model's own arithmetic is a tautology, and reporting it as "unreachable" proves
nothing. `examples/model-faults/patterns/vacuity.mjs` in the repo does that
check by flipping the contract's knobs and looking for a witness.

## Scale

One user action, ≤4 operations, ≤6 steps. A 4×4 grid is 16 targets, a few
minutes to enumerate once. Six operations with five outcomes each is 15,625
targets — not a coverage plan, a hang.
