# Timing: solved, not chosen

A hand-picked millisecond value is the most reliable way to make a fault suite
flaky. The numbers are not independent — the probe window, the tolerated delay,
the tripping delay and the page timeout all hang off the app's own deadline and
off what the machine can actually keep — so they are solved together from a
measured profile.

## Measure the machine, then let it solve

```bash
chaosbringer model calibrate --url http://localhost:3000 --runs 3 --out model/profile.json
```

```js
// bridge.mjs — no settleMs, no delay constants
export default {
  appDeadlineMs: 700,   // must match the app's own AbortSignal.timeout
  timingProfile: JSON.parse(readFileSync(new URL("./profile.json", import.meta.url), "utf8")),
};
```

`--runs 3` is not politeness: a single warm run under-reports the tail, and the
solver takes the envelope. **Calibrate under the load your CI actually has.** A
profile measured on an idle machine is not a bound on a loaded one, and the
probe side is where that bites — `page.waitForTimeout` goes through a CDP round
trip and overshoots by ~100ms under single-core contention where it overshoots
by 3ms idle.

## Driving the page yourself: which number goes where

The rest of this file is written around a model bridge, but the arithmetic is
the same when you own the page. `solveTiming` returns the whole set; here is
what each one is for in a hand-written test.

```js
import { solveTiming, DEFAULT_TIMING_PROFILE } from "chaosbringer";
const t = solveTiming(profile ?? DEFAULT_TIMING_PROFILE, { deadlineMs: 800 });
if (t.status !== "sat") throw new Error(t.explanation);
```

| field | what you do with it |
|---|---|
| `settleMs` | wait this long after the click, then read the page. Long enough that the app's own bound has certainly expired, so "still loading" means unbounded rather than merely slow |
| `quiescenceMs` | wait this much *again* and read a second time. Catches the label that moves after you looked, the retry scheduled on the error path, the write that commits late |
| `slowMs` | the delay to inject when you want the response to arrive **past** the app's bound (`faults.delay(t.slowMs, …)`) |
| `fastMs` | the delay for "slow but tolerable" — the control that stops an over-eager fix from passing |
| `releaseMs` | `faults.hang({ releaseAfterMs: t.releaseMs })` when you want the parked request to let go on its own instead of calling `release()` |
| `pageTimeoutMs` | `page.goto(url, { timeout: t.pageTimeoutMs })` — navigation only, sized for the largest delay a plan can inject |
| `wallClockMs` | the whole thing end to end, for a per-test timeout |
| `profile` | your input **after the safety factor** — so the numbers differ from what you passed in. Not a bug; read invariants off this one, not off your original |

Generosity is cheap for a terminal-state oracle and expensive for a
does-it-still-move one: waiting too long only slows a suite whose question is
"did the app reach a terminal state", but it can hide a bug whose symptom is
transient. Wait long for the first, and be careful about the second.

## When you cannot calibrate

`model calibrate` launches a browser, so it needs one. If the CLI's own
`playwright` resolves to a version whose browser build is not installed — a
sandbox, a `file:` install, a CI image pinned differently — it cannot run, and
there is no flag to hand it an `executablePath`.

The fallback is `DEFAULT_TIMING_PROFILE`, exported from the package:

```js
import { DEFAULT_TIMING_PROFILE, solveTiming } from "chaosbringer";
const solved = solveTiming(DEFAULT_TIMING_PROFILE, { deadlineMs: 700 });
```

It is deliberately pessimistic — roughly twice a warm envelope — so plans built
on it are slower than they need to be but not flakier. Say in a comment that
the profile is a default rather than a measurement, because the next person
will otherwise assume the numbers describe their machine.

`solveTiming(profile, request)` is the call the whole file is about, and it
returns a union: `status: "sat"` carries `settleMs`, `slowMs`, `fastMs`,
`quiescenceMs`, `pageTimeoutMs`, `wallClockMs` and the resolved `profile`;
`status: "unsat"` carries `core` (which constraints could not be met) and a
readable `explanation`. Check the status — the fields do not exist on the unsat
branch. If the app has its own retry ladder, pass
`ladder: { attempts, backoffsMs }` and the window covers all of it, not one
round.

## What gets derived

| value | why it exists |
|---|---|
| `settleMs` | a probe firing before the app's own deadline reports a correctly-bounded request as `stuck` |
| tolerated delay (`slow-ok`) | jitter must not push a "tolerable" delay past the deadline |
| tripping delay (`slow-trip`) | against an app with **no** bound the response still arrives; landing before the probe, it reads as healthy |
| `quiescenceMs` | the observation window after the probe — a retry the app scheduled on the error path has to have run before you claim no rejection escaped |
| `pageTimeout` | `timeout` bounds `page.goto`, so what can overrun it is a page whose *load* issues the delayed request |

Infeasible is a first-class answer. A deadline smaller than the machine's own
jitter cannot be tested at all, and the solver says so with the number to raise
it to. If the message blames the safety factor, that is real — the shipped
default profile is already pessimistic and the solver multiplies it again.

## An app that retries needs a ladder

`appDeadlineMs` describes **one** request. If the app's terminal state is three
bounded attempts plus backoffs away, a window solved for one of them reports a
correctly budgeted client as an endless spinner.

Declare the ladder and the window is solved for all of it:

```js
export default {
  appDeadlineMs: 500,
  appLadder: { attempts: 3, backoffsMs: [60, 120] },
  timingProfile,
  // no settleMs: `solveTiming` returns
  // max(oneRound, attempts x (deadline + tightTail + margin) + backoffs)
};
```

The same holds calling it directly — `solveTiming(profile, { deadlineMs, ladder })`
returns the ladder-sized `settleMs`, and `ladderSettleMs` is exported if you want
the number on its own.

You *may* still declare `settleMs` yourself, and then the ladder validates it:
too short and the pre-flight refuses it, naming the number to write. Both paths
work; the difference is who does the arithmetic.

(This section used to say the ladder "only validates" — true when `solveTiming`
ignored `request.ladder`, which was a bug: it returned a one-round window its
own checker rejected. Fixed, and this text with it.)

## Never put milliseconds in a committed plan

Plans carry `slow-ok` / `slow-trip`, which are *intent*. The milliseconds come
from the local profile, so the same committed plan works on a laptop and on a
slower runner. A plan with a number in it is a plan that only works where it was
written.

## Checking a hand-written value

`checkTiming(profile, request, proposed)` scores each constraint and names what
is violated by how much. Use it when you have inherited a suite full of
constants and want to know which ones are load-bearing.
