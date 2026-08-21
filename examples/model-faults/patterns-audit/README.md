# patterns-audit — the red team pointed at the patterns

The [`redteam/`](../redteam/) suite attacks the *oracle*. This one attacks the
seven [patterns](../patterns/) built on it, which is a different question: not
"what can walk past the runner" but **"does each pattern catch a bug of its own
class that its own plans were not written for?"**

Five of them did not. Every finding here replays the pattern's **own committed
plans and own bridge**, imported unmodified, against a page carrying such a bug
in a buggy and a corrected variant — so the proof is a divergence: identical
oracle verdict, different ground truth, where ground truth comes from the audit
server's raw request ledger (every request, before delegation, including ones no
`rules` regex matched), a DOM read, or a raw Playwright run with no chaosbringer
in the loop.

```bash
npx tsx patterns-audit/audit.mts          # every finding + both refutations (~3min)
npx tsx patterns-audit/audit.mts F2       # one of them
npx tsx patterns-audit/model-vacuity.mts  # F6, no browser (~35s), asserts
npx tsx patterns-audit/windows.mts        # the window arithmetic, no browser (~2s)
```

Run in CI by the `adversarial` job, alongside the `redteam/` scripts. That
matters more than it sounds: an uninvoked check and a check that cannot fail are
indistinguishable from the outside, which is exactly what finding F6 was about —
and `model-vacuity.mts` was itself an instance of it for one round, printing a
classification of six hand-listed patterns and always exiting 0. It now runs the
shared `vacuity.mjs`, over every unit the workflow regenerates, and fails when a
target's classification stops matching the committed `targets.txt`.

## What each finding is, and where it stands

| # | Pattern | The claim it broke | Now |
|---|---|---|---|
| F1 | `optimistic-rollback` | `expect.calls` proves the reconcile *request*, not the reconciliation | **closed** — the bridge compares the rows' `data-id` against the server's ids |
| F2 | `reconnect-budget` | a `$`-anchored rule counts bare URLs, and the count *is* the contract | **closed** — `(\?\|$)`, plus a pre-flight refusal of that combination |
| F3 | `pagination-order` | the ordering invariant reads an attribute the app derives from render position | **closed** — the attribute is correlated against the row's own content |
| F4 | `timeout-ladder` | `ui` was read once, so a `Promise.race` "bound" flips `error`→`ready` after the probe | **closed** — `ui@late` |
| F4L | `timeout-ladder` | …and what the *new* label promises about the page was checked only at the probe | **closed** — `uiInvariant@late`, with the unbound page as the control |
| F8 | `token-refresh` | no plan could fail the refresh — the rung where the stampede happens | **closed** — refresh is an operation, and there is a fifth plan for it |
| F7 | `reconnect-budget` | a window solved for one request against an app that retries three times | **closed** — `appLadder` and a named constraint |
| F6 | all models | 13 of 22 `contract-forbids-*` targets could only be answered one way | **closed as tooling** — [`patterns/vacuity.mjs`](../patterns/vacuity.mjs) classifies each one, over all **nine** model units in `examples/` (21 live, 9 by construction, 30 total), and `model-vacuity.mts` asserts the committed `targets.txt` against what it measured |
| F5 | `retry-idempotency` | the state probe asks the app which bucket to read | **open**, and this suite still reports it |

F5 stays open on purpose. The small fix — drop `?session=`, read the total — is
unsound here, because the tests replay seven plans against one server process,
so a session-less total counts other plans' writes and fails a correct run. A
sound fix needs a run-scoped effect ledger the app must expose. It is recorded
in the recipe under [What the oracle still cannot
see](../../../docs/recipes/model-driven-faults.md).

## Two refutations worth keeping

- **An uncapped retry loop is not invisible to `retry-idempotency`.** Its
  double-failure plans predict `error`, and an uncapped client succeeds past the
  end of the schedule — so `ui` catches it. The missing `--calls-var` there is
  not the hole it looks like.
- **The F2 query-string escape does not hide the second write there.**
  `expect.state` reads the server rather than what the fault layers counted, so
  an uncounted write is still observed. That sharpens F2 to exactly where
  `expect.calls` is the sole judge.

A hypothesis that survives an honest attempt to break it is a result. Both are
asserted here, so they cannot quietly stop being true.
