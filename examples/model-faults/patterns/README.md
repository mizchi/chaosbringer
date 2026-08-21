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
| [`timeout-ladder`](./timeout-ladder/) | A request with no bound. Slow and never are different failures: the first must still render, the second must give up. An unbounded app handles the slow case perfectly — which is why the missing bound survives review. | **Yes**, but only if you wait long enough — which is why this pattern's probe window is *solved*, not guessed. |
| [`token-refresh`](./token-refresh/) | A refresh stampede. Two requests hitting 401 together must share one in-flight refresh; one refresh per 401 hammers the endpoint you least want to overload, and on a rotating refresh token the second invalidates the first and logs the user out. | **No.** Both variants render the account fine; only the refresh count differs. |

## Why these need a state probe

Most of these bugs are invisible on screen. A double-charge renders exactly like
a single charge; a refresh stampede renders exactly like one refresh. So a model
names the observable (`orders`, `refreshes`, …), `chaosbringer model compile
--state-var` lifts it into the plan's `expect.state`, and the bridge's
`stateProbe` reads it back. A plan whose expectation nothing can read is
reported as a mismatch rather than passing quietly.

## Anatomy of a pattern

```
patterns/<name>/
  <name>.qnt      the contract: what a correct implementation must do
  enumerate.sh    witness per target state (dev-time: Quint + a JVM)
  compile.sh      witnesses -> plans, carrying this pattern's compile options
  targets.txt     what was asked, including what came back unreachable
  traces/         ITF witnesses
  plans/          compiled plans (committed; replay needs no Quint)
  bridge.mjs      rules / action / uiProbe / stateProbe for the app
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
- **Model actions that are not injections get `--ignore-action`.** The refresh
  in `token-refresh` is something the app does, not something a fault does.
- **Never put milliseconds in a plan.** `timeout-ladder` uses the `slow-ok` /
  `slow-trip` outcomes, which carry intent only: the bridge supplies
  `appDeadlineMs` and a calibration profile, and the runner solves the actual
  delays for the machine it is on. The same committed plans work on a laptop
  and on a slower CI runner. See
  [`docs/recipes/model-driven-faults.md`](../../../docs/recipes/model-driven-faults.md)
  and `chaosbringer model calibrate`.
