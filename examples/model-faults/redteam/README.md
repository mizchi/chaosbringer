# redteam — the oracle under attack

[`patterns-audit/`](../patterns-audit/) attacks the seven
[patterns](../patterns/). This directory attacks the thing they are built on:
the **oracle** itself — `runPlans` + `aggregateCoverage` + `modelRunPassed`.

The question is not "does the app have a bug" but **"what can hold a passing
verdict while being wrong?"**. Every hole below was found by writing an app that
the oracle called clean and then measuring the app independently — from the Node
process's own effect ledger, from a DOM read the oracle never took, or from a raw
Playwright run with no chaosbringer in the loop.

```bash
cd examples/model-faults
pnpm test:adversarial                  # everything, in CI's own order (~4min)

npx tsx redteam/order-sensitivity.mts  # no browser, fails in seconds
npx tsx redteam/guardwalk.mts          # the blue team (~30s)
npx tsx redteam/attack.mts             # the six holes (~90s)
npx tsx redteam/timing-probe.mts       # what this machine can actually observe
```

Ordered fastest-first on purpose: the no-browser check fails before a browser is
launched. `EXPECT`/`PROOF` lines are assertions and every script exits non-zero
when one does not hold, so a hole that reopens — or a check that starts failing a
*correct* app — is a red run rather than a paragraph nobody re-reads.

## The files

| File | What it does |
|---|---|
| [`attack.mts`](./attack.mts) | The six holes, each with a buggy and a fixed variant of the same page, plus an independent proof per hole. All six are closed, so the expectations are inverted and asserted: the oracle must now separate the two apps, and must not fail the correct one. |
| [`guardwalk.mts`](./guardwalk.mts) | The blue team. Each new check is pushed at from the other side — an app that legitimately makes more calls than the model described, an observable still moving when the probe reads it, a page-load fetch with no action, a page that never goes quiet. A check that turns a blind spot into a flaky failure has not helped. |
| [`order-sensitivity.mts`](./order-sensitivity.mts) | `markOrderSensitivePlans`, without a browser: which plans a browser cannot enforce the ordering of, so they are skipped rather than run as a coin flip. |
| [`timing-probe.mts`](./timing-probe.mts) | What this machine can actually observe: the injection floor, the jitter tails, and how close to a deadline a verdict is still a verdict. The measurements behind `model/profile.json`. |
| [`server.ts`](./server.ts) + [`public/`](./public/) | The pages under attack, and the **effect ledger** — per-session server-side truth (charges, orders, telemetry counts) that the page cannot lie about, because the page never speaks to it. |
| [`plans/`](./plans/) | Hand-written plans for shapes no model here compiles to. Hand-written on purpose: several of these holes are exactly the rung a model does not have an action for. |

## The holes, and where they stand

| # | The hole | Now |
|---|---|---|
| A | Right label, wrong page: `ui: "error"` while the stale price is still on screen and Pay is still enabled — an \$80 charge behind an error banner | closed — `uiInvariants`, the app's contract for what a label *promises* |
| B | Amplification measured and discarded: a 60ms heartbeat where the author meant 60s fires the planned outcome exactly as predicted, then floods the endpoint | closed — `expect.calls` is always checked; the span comparison is opt-in (`checkAmplification`) |
| C | A plan whose every step is `pass` asserts nothing: a page that issues no requests at all satisfies it | closed — an all-`pass` plan's operations are counted, so "the app never called it" is a finding |
| D | The state probe is a single early snapshot: a duplicate write that commits *after* it | closed — a second read after the observation window, reported when the two disagree and the settled one is wrong |
| E | Stale response wins: right label, content from the wrong query | closed — a `uiInvariant` correlating what is rendered against what was asked |
| F | `unhandledRejection` watched only until the probe: a retry that escapes 900ms later | closed — `unhandledRejection@late` |
| R | A non-fetch transport (XHR): false pass, or honest report? | **refuted** — reported as `injection` (not exercised), never as a pass |

Two things this suite deliberately does not do: it does not use the oracle to
prove the oracle (every hole has a measurement from outside it), and it does not
delete a refutation. A hypothesis that survives an honest attempt to break it is
a result, so `R` stays, with the output that refuted it.

## What it still cannot see

The limits are written up where a reader looking for them will find them —
[`docs/recipes/model-driven-faults.md`](../../../docs/recipes/model-driven-faults.md),
under *What the oracle still cannot see* — and `patterns-audit/README.md` keeps
F5 open with the same honesty: a state probe the app parameterises is a probe
that reads the bucket the app chose.
