# Real-world async patterns

The 4×4 grid in [`../model/`](../model/) is a tutorial: two parallel loads, one
action, every combination. These are the shapes that actually break in
production — each one a model of what a correct implementation must do, the
plans enumerated from it, and the specific bug class it catches.

```bash
npx tsx patterns/run-pattern.mts retry-idempotency          # buggy variant
FIXED=1 npx tsx patterns/run-pattern.mts retry-idempotency  # corrected
pnpm test:patterns                                          # all of them, both variants
```

| Pattern | Catches | Visible in the UI? |
|---|---|---|
| [`retry-idempotency`](./retry-idempotency/) | A retry that writes twice. The dangerous failure is the one where the server **committed** and the client could not read the reply — without one idempotency key per intent, the retry is a second order. | **No.** Same "Order placed" banner either way; only the server's order count differs. |
| [`pagination-order`](./pagination-order/) | Page 2 overtaking page 1. Two "load more" clicks are two requests, and nothing about the network returns them in the order they left; an app that appends on arrival is correct exactly as long as the network is. | **Yes, and every signal says otherwise.** Four rows, a `ready` banner, no escaped rejection — the model's prediction met exactly, in the wrong order. |
| [`reconnect-budget`](./reconnect-budget/) | A reconnect loop with no cap. Retrying a dropped stream is not the question; what the client does when the retry *also* fails is, because every client in the fleet is doing it at once against the service that is already failing. | **No, and worse than no.** The uncapped client eventually connects, so it renders a success. "It recovers" and "it hammers a failing service until it recovers" differ by one number. |
| [`timeout-ladder`](./timeout-ladder/) | A request with no bound. Slow and never are different failures: the first must still render, the second must give up. An unbounded app handles the slow case perfectly — which is why the missing bound survives review. | **Yes**, but only if you wait long enough — which is why this pattern's probe window is *solved*, not guessed. |
| [`optimistic-rollback`](./optimistic-rollback/) | An optimistic row the server never took. "Roll back on error" is the wrong contract: a request that never arrived and a reply that could not be read need *opposite* corrections, and only asking the server tells them apart. | **Partly.** The row that should have vanished is visible — but the app that keeps a committed row *without asking* looks identical to one that knows, and only the missing read separates them. |
| [`token-refresh`](./token-refresh/) | A refresh stampede, and the retry loop under it. Two requests hitting 401 together must share one in-flight refresh; one refresh per 401 hammers the endpoint you least want to overload. And when the *refresh* comes back 401 there is nothing left to try — retrying it is where an auth-loop outage comes from. | **No** for the stampede: both variants render the account fine and only the count differs. **Yes** for the failed refresh, and only because the fixed client says so out loud instead of spinning. |

## Why these need a state probe

Most of these bugs are invisible on screen. A double-charge renders exactly like
a single charge; a refresh stampede renders exactly like one refresh. So a model
names the observable (`orders`, `refreshes`, …), `chaosbringer model compile
--state-var` lifts it into the plan's `expect.state`, and the bridge's
`stateProbe` reads it back. A plan whose expectation nothing can read is
reported as a mismatch rather than passing quietly.

`optimistic-rollback` needs one thing a state probe cannot give it. Its worst
case ends with the *right* rows on screen: the server committed, the reply was
lost, and an app that simply kept the optimistic row is correct by luck. Every
state assertion passes. What distinguishes it from an app that knows is a
request — the reconcile read — so the model counts list reads and
`--calls-var list=listCalls` lifts that count into `expect.calls`. A call the
app owes the user is not always a call a fault can target.

That count proves the request, and a count of requests cannot prove that
anybody read the answer. `void refetch()` / `invalidateQueries()` next to a
local promotion issues the GET, drops the body, keeps the row under a
`local-1` id no other client can address — and satisfies `expect.calls`,
`committed == shown`, and every plan in both directions. So the bridge also
declares a `uiInvariants` entry that compares the rows' `data-id`s against the
server's own ids, read from `/api/notes/count` (an endpoint neither rule
matches, so the check cannot inflate the count it sits next to). The count says
the app asked; the ids say it listened.

## Why one pattern needs a UI invariant instead

`pagination-order` is the pattern where every per-plan expectation passes.
Prompt page 1 and slow page 1 predict *identical* oracles — same label, same row
count, same absence of rejections — and the plans say so, byte for byte. What
differs is the order of the rows.

That claim does not belong in a model. "Rows are in ascending order and none is
repeated" is a rule about this app's DOM, and a model that enumerated orderings
would be specifying an implementation and repeating itself in every plan. So the
bridge declares it once as a `uiInvariants` entry, keyed by the label it applies
to (or `"*"`), and the runner checks it wherever that label is predicted. The
model says what state the app should reach; the invariant says what that state
means on screen.

The corollary is worth stating plainly: this needs one line of help from the
app. The rows carry `data-idx`, which is what makes "in order" an assertion
rather than an opinion. An app that renders bare strings exposes no correlation,
and a stale or reordered response there is outside what any oracle can see —
see the recipe's [What the oracle still cannot
see](../../../docs/recipes/model-driven-faults.md).

And the corollary's corollary, which is where this nearly went wrong: the
attribute has to be **independently derivable** from the row's content or from
the response it came from. `data-idx` is written by the app, so an invariant
that compares it against its own sort is only an assertion while that holds. An
app that writes the *render position* into it — `dataset.idx =
list.children.length + 1`, which is the shape of every `key={i}` bug — is
ascending and unique by construction: the check compares the render order
against itself and cannot fail, on a page whose visible rows read
`Post 3, Post 4, Post 1, Post 2`. So the invariant correlates two sources that
come from different places first (the attribute against the row's own rendered
`Post <idx>`, which comes from the payload) and only then asks whether the
sequence is in order. One derived attribute is an opinion; two sources that have
to agree is an assertion.

## Why one pattern is only a number

`reconnect-budget` has no `stateProbe` and asserts no state, because there is
nothing to read. A client with a reconnect budget and one without render the
same spinner and then the same connection; what separates them is how many
requests they were willing to make, and no page can report that about itself.
So the model counts attempts and `--calls-var stream=attempts` lifts the total
into `expect.calls`.

Which puts all the weight on one regex, and that is worth saying out loud. When
`expect.calls` is the only judge, the rule's `urlPattern` is not selecting
requests for the assertion — it *is* the number being asserted. `/\/api\/stream$/`
does not match `/api/stream?cursor=…`, so a client that resumes with a cursor
every 25ms forever is neither faulted nor counted: 58 requests, reported as the
9 the model predicted, in a pattern that has no state probe and no other
assertion. The rule is `(\?|$)`-terminated for that reason, and the runner now
*refuses* a `$`-anchored pattern on any operation a plan counts, before the
browser launches. Anchoring elsewhere is fine — `pagination-order` anchors
`?page=1$` on purpose — because there too narrow shows up as a missing
injection rather than as a wrong number.

Its window is declared rather than solved, for the same "the contract is a
ladder" reason: see the timing note in [Anatomy](#anatomy-of-a-pattern) below.

Its buggy variant is worth sitting with. Given three failures it makes a fourth
attempt — which the schedule lets through, because a schedule describes the
occurrences it enumerated — so it *connects*, and renders a success. Two
mismatches fire, and the pair is the finding: `ui` alone says "predicted
offline, got live", which reads like a labelling quibble and is exactly how an
unbounded retry gets waved through review. The call count is what says the
client kept going.

The bridge does **not** set `checkAmplification: true`, and the reason is worth
stating: that flag compares against the schedule's occurrence span and is a
claim about the *model* covering every call to a URL. Here every plan already
states an exact `expect.calls`, so the flag would only produce a second mismatch
for the same fact. Redundant signals are not a demonstration.

## Anatomy of a pattern

```
patterns/<name>/
  <name>.qnt      the contract: what a correct implementation must do
  enumerate.sh    witness per target state (dev-time: Quint + a JVM)
  compile.sh      witnesses -> plans, carrying this pattern's compile options
  targets.txt     what was asked, including what came back unreachable —
                  and, for the contract-forbids rows, whether a witness was
                  ever possible (`unreachable-live` vs
                  `unreachable-by-construction`)
  traces/         ITF witnesses
  plans/          compiled plans (committed; replay needs no Quint)
  bridge.mjs      rules / action / uiProbe / stateProbe for the app
```
…plus one file shared by all of them, [`vacuity.mjs`](./vacuity.mjs), which
every `enumerate.sh` calls at the end:

```bash
node patterns/vacuity.mjs                    # all seven models, ~21s, no JVM
node patterns/vacuity.mjs reconnect-budget   # one of them
```
…plus a page in [`../public/`](../public/), its routes in
[`../server.ts`](../server.ts), and a row in [`index.mjs`](./index.mjs).

Two conventions that keep them honest:

- **Target the grid, not the terminal state.** The shortest witness for "order
  placed, one order" is a first attempt that just works — which never exercises
  the retry. Recording each step's outcome as model state and enumerating over
  *that* is what makes the interesting interleavings appear.
- **Assert both directions.** The buggy variant must produce the specific
  mismatch the pattern exists for, and the fixed variant must produce none. A
  pattern that only ever passes proves nothing.
- **Keep controls in the enumeration.** `token-refresh` enumerates the
  single-401 cases as well as the double, and they must pass in *both*
  variants — otherwise the pattern would be flagging refreshes in general
  rather than the stampede. The enumeration gives you those controls for free;
  a hand-written test usually skips them.
- **The `enumerate.sh` + `compile.sh` + `plans/` triple is what CI looks for.**
  [`model-plans.yml`](../../../.github/workflows/model-plans.yml) globs for it
  and gives each match its own matrix leg, so a new pattern is regenerated and
  drift-checked without anyone editing the workflow — and it parallelises
  instead of extending one job's wall clock. A pattern that owns its compile
  options in `compile.sh` needs no CI change at all; one that leaves them in a
  README needs a human to remember, which is the same as not having them.
- **A `contract-forbids-*` query has to be able to fail.** `quint verify`
  answers "unreachable" the same way whether the contract forbids the state or
  the predicate restates the model's own arithmetic, and both cost ~14s and a
  JVM. `vacuity.mjs` re-asks each one against a knob-inverted copy of the model
  and writes `unreachable-live` or `unreachable-by-construction` into
  `targets.txt`. Where the *headline* property turns out to be a tautology,
  give the model the knob that makes it falsifiable: `reconnect.qnt`'s
  `withinBudget` was a restatement of its own assignment until `BUDGETED`
  existed, and that one knob made all four of that pattern's targets live.
- **Model actions that are not injections get `--ignore-action`** — but check
  whether they should be actions instead. `token-refresh` used to ignore its
  `refresh`: the endpoint was not in `rules`, `refreshAndReplay` was atomic and
  always succeeded, and so *no plan could make the refresh fail* — the one rung
  where a client that loops against a failing refresh differs from one that
  gives up. Splitting it into `refresh` + `replay` and giving the endpoint a
  rule of its own is what made that rung expressible; the flag went away with
  the atomicity it was papering over.
- **A window is one bounded round unless you say otherwise.** `appDeadlineMs`
  describes one request, so the solved `settleMs` covers one. If your app
  retries, declare the ladder — `appLadder: { attempts, backoffsMs }` plus a
  `settleMs` that covers it — and the pre-flight validates the pair.
  `reconnect-budget` got away with a 531ms window against a 1680ms ladder only
  because every enumerated failure is an instantaneous client-side reject.
- **Never put milliseconds in a plan.** `timeout-ladder` uses the `slow-ok` /
  `slow-trip` outcomes, which carry intent only: the bridge supplies
  `appDeadlineMs` and a calibration profile, and the runner solves the actual
  delays for the machine it is on. The same committed plans work on a laptop
  and on a slower CI runner. See
  [`docs/recipes/model-driven-faults.md`](../../../docs/recipes/model-driven-faults.md)
  and `chaosbringer model calibrate`.
