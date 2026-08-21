---
name: chaosbringer
description: >-
  Write fault-injection and chaos tests for a web app with chaosbringer — deliberately
  breaking fetches, delaying responses, hanging requests, or enumerating a failure space with
  a model checker, then asserting the app handled it. Use this skill whenever someone wants to
  test how their app behaves when the network or an API misbehaves — flaky requests, slow or
  hanging endpoints, retries that double-write, error states that leave stale data on screen,
  unhandled promise rejections, "it works locally but breaks in production", or a post-
  incident regression test for an async bug. Also use it for anything mentioning chaosbringer,
  ChaosCrawler, fault injection, faults.delay, faults.status, model-driven faults, or Quint
  plans.
---

# chaosbringer

A fault-injection harness for browsers. You point it at a page, tell it which
requests to break and how, and it asserts the app coped.

The single most useful thing to understand before writing any of it: **a fault
test is only worth as much as its oracle.** Breaking a request is easy; knowing
what *should* have happened is the hard part, and it decides whether a green run
means anything. Most of this skill is about that.

## Pick the layer before you write anything

Four ways to inject, and choosing wrong is the most common way to waste an hour.

| You want | Use | Because |
|---|---|---|
| an HTTP response the app never asked for (500, 429, a delay) | **network** (`faultInjection`) | it intercepts at Playwright's route layer, so the app sees a real, wrong response |
| the `fetch()` call itself to fail — `TypeError`, `AbortError`, a body that won't parse | **runtime** (`runtimeFaults`) | a client-side rejection issues no request, so no route can produce it |
| a page that never gets a response at all | network `hang`, or runtime `never-settle-fetch` | see below — they differ on cancellation |
| the app's own lifecycle to misbehave (visibility, offline, storage) | **lifecycle** (`lifecycleFaults`) | not a request at all |

The two hang flavours are not interchangeable. `never-settle-fetch` honours
`init.signal`, so an app that bounds its request with `AbortSignal.timeout`
recovers and only an app that *cannot* cancel is left hanging — which is what
you want when you are testing whether a bound exists. The network `hang` parks
the request outside the page's reach.

**One URL can host two operations.** `GET /api/todos` and `POST /api/todos` are
different failures with different contracts, so rules take a method filter:
`{ urlPattern: /\/api\/todos$/, methods: ["POST"] }`. Without it your fault
fires on whichever call arrives first, which is usually the page-load read.

## Two ways to run, and when each is right

### Probability, for breadth

`chaosbringer crawl --url … --seed 42` walks the app breaking things at random.
Good for "does anything here explode", bad for "was *this* case covered": after
a run you know what fired, never what was never attempted. Reach for it first
when exploring an unfamiliar app.

### Deterministic schedules, for a specific case

```js
{ urlPattern: /\/api\/cart$/, fault: faults.status(500),
  schedule: { decisions: ["pass", "inject"], afterEnd: "pass" } }
```

A decision table indexed by how many times the rule already matched: the first
call passes, the second 500s, the rest pass. Consumes no randomness, so it does
not disturb a seed. This is what you want for a regression test of a known bug —
"the retry is the one that fails" is a schedule, not a probability.

### Model-driven, when you need to claim coverage

When the question is "which failure states did we actually cover", a temporal
model enumerates them and each state becomes a replayable plan with the model's
own prediction as the oracle. It is more work and it earns you a claim the other
two cannot make. Read `references/model-driven.md` before starting one — the
pipeline has several conventions that are cheap to follow and expensive to
discover.

## Writing an oracle that can fail

Every mode needs you to answer "and what should have happened?". The ways this
goes wrong, in rough order of how often:

**Asserting a label instead of a state.** `data-state="error"` is satisfied by an
app that shows an error banner *and leaves the stale total on screen with the Pay
button enabled*. If the label is the whole assertion, that app passes. Check
what the label promises about the page, not just the label.

**Asserting at one instant.** A probe fires once. A backend that acknowledges now
and commits 450ms later, a retry scheduled on the error path, a revalidation
whose response arrives after you looked — all land after that instant, and a
single read calls them clean. Decide whether your bug can move after the probe;
if it can, you need a second look.

**Asserting a count the app chose.** A probe that asks the app which bucket to
read (`/api/orders/count?session=` + whatever the page put in a global) can be
lied to by the app under test. Prefer a reader the app does not parameterise.

**Not checking that the fault fired.** The failure mode is silent: a plan whose
request the app never issues looks exactly like a pass. Assert the injection
happened. Everything else in this harness is downstream of that one.

## Verifying your work

Run it against a *correct* version of the app as well as the broken one. A fault
test that only ever passes proves nothing, and one that fails against correct
code is worse than nothing. If you cannot produce a correct variant, at minimum
run the same test with the fault removed and confirm it passes — that separates
"my assertion works" from "my assertion always fires".

For timing faults specifically, never hard-code milliseconds. See
`references/timing.md`: the right delay depends on the machine, the harness
solves it from the app's own deadline, and a hand-picked constant is how a suite
becomes flaky on CI.

## Reference files

Read the one you need; they are written to be read in isolation.

- `references/api.md` — the concrete API: options, fault constructors, report
  fields, the Playwright Test integration. Start here when you know what you
  want and need the call signature.
- `references/model-driven.md` — the enumerate → compile → replay pipeline, the
  model's own vocabulary, and the conventions that are not guessable.
- `references/timing.md` — delays, probe windows, and why they are solved rather
  than chosen.
- `references/recipes.md` — the shapes that recur: retry idempotency, token
  refresh, timeout ladders, optimistic rollback, pagination order, reconnect
  budgets, stale-while-revalidate. Read this before inventing a test for an
  async bug; the bug probably has a name here.

In the chaosbringer repo itself, `docs/cookbook/` and `docs/recipes/` go deeper,
and `examples/` is runnable.
