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

## Getting a fault onto a page

Before the interesting part, the two things that cost people their first half
hour.

**Install `playwright`, and `@playwright/test` only if you want the fixture.**
The package root imports `playwright`; `chaosbringer/fixture` is the only
subpath that needs `@playwright/test`. Both are peers, so they come from your
project, not from this package.

**Pick your entry point by how much you want to drive.**

```ts
// (a) You drive the page. Best for a regression test of one known incident.
import { applyFaultRules, faults } from "chaosbringer";

const session = await applyFaultRules(page, [
  faults.status(500, { name: "save-500", urlPattern: /\/api\/save$/, methods: ["POST"] }),
]);
await page.getByRole("button", { name: "Save" }).click();
expect(session.stats()[0]).toMatchObject({ matched: 1, injected: 1 }); // it fired
// …assert what the app did…
await session.dispose();          // release parked requests, drop the route
```

```ts
// (b) chaosbringer drives. Best for "break things across the app and tell me".
import { chaos, faults } from "chaosbringer";
const { exitCode } = await chaos({ baseUrl, faultInjection: [...], strict: true });
```

```ts
// (c) Inside Playwright Test.
import { chaosTest } from "chaosbringer/fixture";   // note the subpath
chaosTest("home survives a 500", async ({ page, chaos }) => {
  const result = await chaos.testPage(page, url);
  expect(result.errors).toHaveLength(0);            // PageResult.errors
});
```

`applyFaultRules` is the one to reach for when you know which click matters. It
takes the same `FaultRule[]` as `chaos()` and makes the same decisions — same
schedules, same occurrence numbering — but runs no crawl, so nothing random
happens between your click and your assertion.

**If you need chaosbringer to drive the page but along a *known* path**, use
`flowDriver` rather than the default weighted-random driver: a fault test that
cannot say which button was pressed cannot make a claim. One trap, and it is
silent — a `flowDriver` instance is stateful and one-shot. Reusing one across
two `chaos()` calls produces a run with **no actions at all**, which looks
exactly like a wrong `urlPattern`. Build a fresh one per run.

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

## Fault shapes that decide which bug you find

**`faults.status(500, { urlPattern })` sends a JSON body by default** —
`{"error":500}`, because Chromium emits a spurious `ERR_ABORTED` alongside an
empty intercepted body. That default picks the bug: a client that skips
`res.ok` and calls `res.json()` renders `undefined` from it, whereas an HTML or
empty body makes `res.json()` *reject* and takes a different path. Both are
real; if you care about the second, pass `body: ""` explicitly.

**A route-level fault never reaches your server.** `status`, `abort` and
unbounded `hang` are fulfilled in the browser, so a bug that needs the server to
have *committed* something — the classic retry that writes twice — cannot be
reproduced with them. The fault with that causal shape is
`faults.rejectBody()`: the real request goes out, the server commits, and
`res.json()` rejects on the way back. If you are chasing a double-write, this is
the one.

**`never-settle-fetch` rejects as `TimeoutError` under `AbortSignal.timeout`,**
not `AbortError` (an explicit `controller.abort()` still gives `AbortError`). An
app whose `catch` branches on `err.name === "AbortError"` will look broken when
it is not, and vice versa.

**`ignoreErrorPatterns` matches `PageError.message`.** For a network error that
message is `"<url> - <errorText>"`, so a pattern can name either half. Use it to
silence a pre-existing defect that is not what you are testing — but say so out
loud, because silencing an error is indistinguishable from fixing it in a green
run.

**Exit codes:** a page that errors or times out, or any invariant violation,
fails in every mode. Console errors, JS exceptions and unhandled rejections
fail only under `strict: true`. If your finding is "a rejection escaped", you
need `strict`.

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
request the app never issues looks exactly like a pass, and so does a typo'd
`urlPattern`. Assert the injection happened — `session.stats()` from
`applyFaultRules`, or `report.faultInjections` from a crawl. `matched: 0` means
your pattern never saw the request; `matched: 3, injected: 0` on a scheduled
rule means something else answered first (that is what `suppressed` counts).
Everything else in this harness is downstream of this one check.

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

## Two ways a harness lies to you

Both of these produced a confident wrong answer for somebody, and neither looks
like a bug while it is happening.

**Shared server state across scenarios.** Calling an app's exported `start()`
once per scenario shares its module-level state, so scenario 2 sees scenario 1's
writes and a "duplicate write" finding may be two different scenarios' writes.
One app *process* per scenario, or a per-scenario namespace the app honours.

**A reader the faults can intercept.** If you verify server state with
`page.request.get(...)`, that request goes through the same route layer as the
app's — so a catch-all rule can fault your own oracle. Read from the test
process (plain `fetch` in Node) instead. And label harness failures distinctly
from app findings: an inconclusive run reported as a violation is worse than no
run.

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

Deeper material lives in the repository rather than the npm package —
`docs/recipes/model-driven-faults.md`, `docs/cookbook/`, and a runnable
`examples/` — at <https://github.com/mizchi/chaosbringer>. If you are working
from an installed copy, `node_modules/chaosbringer/dist/*.d.ts` is the most
complete reference you have locally, and it is worth reading: several fault
behaviours are documented only there.
