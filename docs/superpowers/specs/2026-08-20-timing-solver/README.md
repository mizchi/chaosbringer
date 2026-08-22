# Timing solver — dev-time oracle

Reference material for `packages/chaosbringer/src/timing.ts`. Nothing here is
wired into the build; the shipped solver is a closed form in TypeScript with no
solver dependency, exactly as plans ship without Quint.

```bash
pip install z3-solver

# 1. Prove the shipped closed form IS the optimum (and agrees on infeasible).
python3 verify-closed-form.py
#   swept 192 parameter combinations: closed form == z3 optimum in 192/192
#     (66 of them agreed on INFEASIBLE, which is the interesting half)

# 2. Explore the constraint system interactively.
python3 timing-solver.py solve  --deadline 5000
python3 timing-solver.py check  --deadline 5000 --settle 1200   # the real misconfig
python3 timing-solver.py solve  --deadline 120 --fast 20        # expect UNSAT
python3 timing-solver.py ladder --lo 20 --hi 15000 --budget 60000
```

## Why a solver at all

Timing values were hand-picked, and one of them was wrong: a `settleMs` of
1200ms against an app deadline of 5000ms, which reported a correctly-bounded
request as `stuck`. The values are not independent — the probe window, the
tolerated delay, the tripping delay, the release bound and the page timeout all
hang off the app's own deadline and off what the machine can actually keep — so
picking them by hand is picking one point in a constraint system by eye.

## What the environment can keep (this container, 3 calibration runs)

| mechanism | floor | additive jitter |
|---|---|---|
| `delay` (route + setTimeout + fallback) | **4ms** | **61ms** envelope; a *cold* run measured **107ms** |
| `AbortSignal` / deadline firing | 0ms | **3ms** |
| probe window (`waitForTimeout`) | — | **3ms idle; 52ms measured under load, 104ms observed** |
| fixed per plan (launch + load + teardown) | **~700ms** | — |

The asymmetry is real: deadlines are near-exact, injected delays are not, and a
hand-picked constant has no way to know that.

**What this table got wrong, and it mattered.** The probe row originally read
"1–3ms", measured on an idle container, and the paragraph here concluded that
separations on the probe side "need ~5ms". Both are true of an idle machine and
neither is a bound. `page.waitForTimeout(settleMs)` is a tight wait through a
CDP round trip; under single-core contention it overshoots by ~100ms. The
solver's tripping delay was separated from the *nominal* probe instant by
`margin − floor` on the strength of that ~5ms figure — 22ms, unaffected by
anything in the profile — and the consequence was the worst verdict this system
can produce: the tripping response landing before the probe, so an app with no
deadline at all reads as healthy. `slow` is now separated by
`tightTail + margin − floor`, which scales with the measurement, and
`tightTailMs` is calibrated under load. A jitter figure measured idle belongs in
a table labelled "idle", not in a constraint.

## Empirical check

`solve --deadline 600` yields `fast=457` (must be tolerated) and `slow=693`
(must trip). Run against a client bounding its request with
`AbortSignal.timeout(600)`, 15 trials each:

| candidate | unthrottled | 4× CPU throttle |
|---|---|---|
| `fast=457` (solved) | 15/15 ok, observed 463–468ms | 15/15 ok, 465–477ms |
| `slow=693` (solved) | 15/15 error, 600–601ms | 15/15 error |
| `fast=590` (**solver rejects**) | 13 ok / **2 error**, 596–**606**ms | 11 ok / **4 error** |

The rejected value is 133ms closer to the deadline and misclassifies 13–27% of
the time — without any throttling on the first run. That is the flake the
margin exists to prevent, and the reason `checkTiming` refuses it.
