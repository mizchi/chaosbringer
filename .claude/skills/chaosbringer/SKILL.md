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

A fault-injection harness for browsers: you point it at a page, say which
requests to break and how, and assert the app coped.

The thing to understand before writing any of it: **a fault test is worth
exactly as much as its oracle.** Breaking a request is easy; knowing what
*should* have happened is the hard part, and it decides whether a green run
means anything.

## Getting a fault onto a page

Install `playwright`. `@playwright/test` is only needed for
`chaosbringer/fixture` — the package root doesn't touch it.

```ts
import { applyFaults, faults } from "chaosbringer";

const session = await applyFaults(page, {
  // `network:` for an HTTP response the app never asked for:
  //   [faults.status(500, { name: "save-500", urlPattern: /\/api\/save$/, methods: ["POST"] })]
  // `runtime:` for the fetch() call itself misbehaving. Installed as an init
  // script, so apply BEFORE navigating — on an already-loaded page it does
  // nothing and `runtimeStats()` reports `matched: 0` saying so.
  runtime: [faults.rejectBody({ name: "save-unreadable", urlPattern: /\/api\/save$/, methods: ["POST"] })],
});
await page.goto(url);
await page.getByRole("button", { name: "Save" }).click();

const [save] = await session.firings();
expect(save.fired).toBeGreaterThan(0);   // it really happened — see below
// …assert what the app did…
await session.dispose();     // release parked requests, drop the route
```

Give each fault a `name`. Without one the label is derived from the action
(`"reject-body:json"`), which is fine until you are matching on it.

You drive the page: no crawl, no random driver, nothing happening between your
click and your assertion. This is the shape a regression test for one incident
wants. `applyFaultRules(page, rules)` is the network-only shorthand.

The alternatives, and when they beat it:

- **`chaos({ baseUrl, faultInjection, strict: true })`** — chaosbringer drives,
  breaking things across the app. Reach for it to explore an unfamiliar app.
  Exit codes and `strict` only exist on this path. If you need it to follow a
  *known* path, pass `driver: flowDriver({ steps })` — the default driver picks
  actions at random, and a test that can't name the button pressed can't make a
  claim. `flowDriver` is one-shot and stateful: reusing an instance across two
  runs performs no actions at all and looks exactly like a wrong `urlPattern`.
  Build a fresh one per run.
- **`chaosTest` from `chaosbringer/fixture`** — inside Playwright Test. Its
  `chaos.testPage(page, url)` returns `PageResult` with **`.errors`** (there is
  no `.violations`), and it only *loads* the page — it clicks nothing, so it is
  the wrong entry point for a fault behind a button.
- **Model-driven** — when the question is "which failure states did we cover",
  a temporal model enumerates them and each state becomes a replayable plan
  with the model's own prediction as the oracle. More work, and it earns a
  claim the others can't make. Read `references/model-driven.md` first; plans
  are hand-writable and the schema is there.

**Did it fire?** Everything else is downstream of this one check: a fault whose
request the app never issues looks exactly like a pass, and so does a typo'd
pattern. The layers disagree about the field name — network says `injected`,
the other three say `fired` — so `stats().injected` on what turned out to be a
runtime fault is `undefined`, and `undefined > 0` is a silent no-op. Use
`session.firings()`, or `faultFirings(report)` / `unfiredFaults(report)` for a
crawl, and never write the field name yourself. `matched: 0` means the pattern
never saw the request; `matched: 3, injected: 0` on a scheduled rule means
something answered first (that's what `suppressed` counts).

## Which layer

| You want | Layer | Because |
|---|---|---|
| an HTTP response the app never asked for (500, 429, a delay) | **network** (`faultInjection`) | intercepts at Playwright's route layer, so the app sees a real, wrong response |
| the `fetch()` call itself to fail — `TypeError`, `AbortError`, a body that won't parse | **runtime** (`runtimeFaults`) | a client-side rejection issues no request, so no route can produce it |
| a page that never gets a response | network `hang` **or** runtime `never-settle-fetch` | either works; they differ in what reaches your server |
| the app's own lifecycle to misbehave (visibility, offline, storage) | **lifecycle** (`lifecycleFaults`) | not a request at all |

The constructors differ in shape by layer: `faults.hang()` returns
`{ urlPattern, fault }` for `faultInjection`, `faults.rejectBody()` returns
`{ urlPattern, action }` for `runtimeFaults`. And a runtime pattern matches
**the string handed to `fetch()`** (`"/api/save"`), not a resolved absolute URL
— an absolute pattern silently matches nothing.

**One URL is often two operations.** `GET /api/todos` and `POST /api/todos` are
different failures with different contracts, so rules take `methods: ["POST"]`.
Without it your fault fires on whichever call arrives first, usually the
page-load read.

**Both hang flavours let a caller that can cancel out** — `AbortSignal.timeout`
aborts the fetch and the browser cancels the request whether or not the route
ever answers — so either tests whether a bound exists. What separates them:
`hang` is a real HTTP request your server sees, held open; `never-settle-fetch`
patches `fetch` in the page and **sends nothing**. A load-time `hang` also
costs the crawler a whole navigation `timeout`, and that rejection is recorded
as a page `exception`, so `summary.jsExceptions` reads 1 for a page that threw
nothing. Expected, not a finding.

## Schedules, not probabilities

```js
{ urlPattern: /\/api\/cart$/, fault: faults.status(500),
  schedule: { decisions: ["pass", "inject"], afterEnd: "pass" } }
```

A decision table indexed by how many times the rule has already matched: first
call passes, second 500s, rest pass. Consumes no randomness, so it can't drift.
"The retry is the one that fails" is a schedule, not a probability — reach for
`probability` only when you're exploring.

## Fault shapes decide which bug you find

**A route-level fault never reaches your server.** `status`, `abort` and
unbounded `hang` are fulfilled in the browser, so a bug that needs the server
to have *committed* — the classic retry that writes twice — cannot be
reproduced with them, and a test written with `status(500)` goes green against
the broken app. The fault with that causality is **`faults.rejectBody()`**: the
real request goes out, the server commits, and `res.json()` rejects on the way
back. Chasing a double-write, this is the one. (Give it a `urlPattern` — bare,
it matches every fetch on the page.)

**`faults.status(500, …)` sends `{"error":500}` by default**, not an empty
body, and that picks which bug you find: a client that skips `res.ok` and calls
`res.json()` renders junk out of it and reports success, whereas on an empty or
HTML body `res.json()` *rejects* and it takes its error path (or leaks an
unhandled rejection). Two defects behind one status code; test both, with
`body: ""` for the second.

**`never-settle-fetch` rejects as `TimeoutError`** under
`AbortSignal.timeout`, not `AbortError` (an explicit `controller.abort()` still
gives `AbortError`). A `catch` branching on the name will look broken when it
isn't.

**Exit codes** (`chaos()` only): a page that errors or times out, and any
invariant violation, fail in every mode. Console errors, JS exceptions and
unhandled rejections fail only under `strict: true` — so if your finding is
"a rejection escaped", you need `strict`. `ignoreErrorPatterns` matches
`PageError.message`, which for a network error is `"<url> - <errorText>"`, so a
pattern can name either half. Silencing a known unrelated defect with it is
fine; say so out loud, because a silenced error and a fixed one look identical
in a green run.

## An oracle that can fail

The ways this goes wrong, in rough order of how often:

**A label instead of a state.** `data-state="error"` is satisfied by an app
that shows an error banner *and leaves the stale total on screen with the Pay
button enabled*. Check what the label promises about the page.

**One instant.** A probe fires once. A backend that acknowledges now and
commits 450ms later, a retry scheduled on the error path, a revalidation
arriving after you looked — a single read calls all of them clean. If your bug
can move after the probe, look twice.

**A count the app chose.** A probe that asks the app which bucket to read
(`/api/orders/count?session=` + whatever the page put in a global) can be lied
to by the app under test. Prefer a reader the app doesn't parameterise.

**A reader the faults can intercept.** `page.request.get(...)` goes through the
same route layer as the app's traffic, so a catch-all rule can fault your own
oracle. Read from the test process instead, and label harness failures
distinctly from findings — an inconclusive run reported as a violation is worse
than no run.

**Shared server state across scenarios.** Calling an app's exported `start()`
once per scenario shares its module-level state, so scenario 2 inherits
scenario 1's writes and a "duplicate write" may be two scenarios' writes. One
app *process* per scenario, or a namespace the app honours.

## Verifying your work

Run it against a *correct* version of the app as well as the broken one, and
**leave that fixed variant on disk** — a both-directions claim you can't re-run
is a claim, not a result. Keep the original file byte-identical and serve the
fix from a sibling (`app.fixed.js` plus a route override, or an env seam). If
you can't produce a correct variant, at minimum run the same test with the
fault removed: that separates "my assertion works" from "my assertion always
fires".

Better still, break it on purpose: re-introduce one regression at a time and
check that only the scenario declaring it fails. A check that cannot fail is
worth nothing, and this is the cheapest proof that yours can.

For timing faults, never hard-code milliseconds. `references/timing.md`: the
right delay depends on the machine, the harness solves it from the app's own
deadline, and a hand-picked constant is how a suite becomes flaky on CI.

## Reference files

Read the one you need; each stands alone.

- `references/api.md` — options, fault constructors, session and report fields,
  the Playwright Test integration. Start here when you know what you want and
  need the call signature.
- `references/model-driven.md` — the enumerate → compile → replay pipeline, the
  plan JSON schema, and the conventions that aren't guessable.
- `references/timing.md` — delays, probe windows, and why they're solved.
- `references/recipes.md` — the shapes that recur: retry idempotency, token
  refresh, timeout ladders, optimistic rollback, pagination order, reconnect
  budgets, stale-while-revalidate. Read it before inventing a test for an async
  bug; the bug probably has a name here.

Deeper material is in the repository rather than the npm package —
`docs/recipes/model-driven-faults.md`, `docs/cookbook/`, a runnable
`examples/` — at <https://github.com/mizchi/chaosbringer>. Working from an
installed copy, `node_modules/chaosbringer/dist/*.d.ts` is the most complete
local reference, and worth reading: some behaviour is documented only there.
