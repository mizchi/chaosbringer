# chaosbringer API

Verified against the source. Where a signature here disagrees with the code,
the code wins — say so rather than working around it.

## Installing and running

```bash
pnpm add -D chaosbringer            # or npm/yarn
npx chaosbringer --url http://localhost:3000 --seed 42
```

**The CLI injects no faults.** It crawls, clicks randomly, and reports console
errors, exceptions, unhandled rejections, dead links, invariants, perf budgets
and axe findings — a useful first look at an unfamiliar app, and a green run
from it says nothing about error handling. The only perturbations it offers are
`--network offline|slow-3g|fast-3g` and `--device`. Fault rules are reachable
from code only: `chaos({ faultInjection, runtimeFaults, … })`, `ChaosCrawler`,
`applyFaults`, or `model run`. If you want breadth *with* faults, that is
`chaos()` with `probability` rules and a seed, not this command.

Working *inside* the chaosbringer repo, the CLI lives at
`packages/chaosbringer/dist/cli.js` and `dist/` is gitignored — so
`pnpm -F chaosbringer build` first. If you get type errors mentioning
`@mizchi/playwright-faults`, build that first:
`pnpm -F @mizchi/playwright-faults build && pnpm -F chaosbringer build`. It is a
workspace dependency and a stale `dist` produces confusing errors.

## Fault constructors (`faults`)

Every one takes `urlPattern` (a `string` or `RegExp` matched against the request
URL) plus its own options. All accept `probability` and `schedule`.

| Constructor | Effect |
|---|---|
| `faults.status(500, { urlPattern })` | respond with that status. **Default body is `{"error":500}`**, not empty — pass `body: ""` for an empty one, and note that the choice decides whether the app's `res.json()` succeeds with junk or rejects |
| `faults.delay(ms, { urlPattern })` | respond, late. Always eventually responds |
| `faults.abort({ urlPattern, errorCode })` | the request fails at the network layer |
| `faults.hang({ urlPattern, releaseAfterMs })` | hold it open, never respond |
| `faults.cpu(rate)` | lifecycle: CPU throttling |
| `faults.rejectBody({ urlPattern, consumers })` | runtime: the request really goes out and the server really commits; `res.json()` rejects on the way back. The only browser-reachable shape that reproduces a write the client could not read. Defaults to `["json"]` |
| `faults.rejectFetch({ urlPattern, rejectAs })` | runtime: `fetch()` itself rejects — `TypeError`, or `AbortError` |
| `faults.neverSettleFetch({ urlPattern })` | runtime: never settles, but honours `init.signal` — so a bounded request escapes and only an unbounded one hangs |

`faults.hang` without `releaseAfterMs` holds until the page closes. The crawler
navigates with `waitUntil: "networkidle"`, so hanging a *navigation-time*
request costs one page `timeout` — hang what an action fires after load, or pass
`releaseAfterMs`.

## The crawler

```js
import { ChaosCrawler, faults } from "chaosbringer";

const crawler = new ChaosCrawler({
  baseUrl: "http://localhost:3000", // REQUIRED — the constructor throws without it
  seed: 42,                         // reproducible; omit for random
  faultInjection: [ … ],            // network layer: FaultRule[]
  runtimeFaults: [ … ],             // in-page fetch patching: RuntimeFault[]
  lifecycleFaults: [ … ],           // visibility, offline, CPU: LifecycleFault[]
  initScripts: [ "…js…" ],          // raw JS run before the page's own scripts
  invariants: [ … ],                // what must hold; see below
});
```

`initScripts` is for anything that has to be in place *before* the app runs —
patching an API you want to observe, seeding a global, stubbing a clock. An
observer installed later reports zero for everything that happened during load,
and zero is indistinguishable from "nothing happened", so if the thing you are
measuring can occur during load, it belongs here rather than in an `afterLoad`
invariant. Each string is evaluated verbatim on every navigation: wrap it in an
IIFE and guard against a second install.

### Reading whether a fault fired

The counters live in different places with different names, and getting this
wrong is silent:

| where | count of matches | count of effects |
|---|---|---|
| `report.faultInjections[]` (network) | `matched` | **`injected`** |
| `report.runtimeFaults[]` | `matched` | **`fired`** |
| `report.lifecycleFaults[]` (row keyed `name`, not `rule`) | `matched` | **`fired`** |
| `report.iframeFaults[]` | `matched` | **`fired`** |
| `session.stats()` from `applyFaults` (network) | `matched` | **`injected`** |
| `session.runtimeStats()` | `matched` | **`fired`** |

`injected` and `fired` are the same question under two names — there is no
object carrying both. So `stats.injected` on what turned out to be a runtime
fault is `undefined`, and `undefined > 0` is `false`: the check quietly passes.
Prefer the readers that normalise it — `session.firings()`, or
`faultFirings(report)` / `unfiredFaults(report)` — and never spell the field
yourself.

Note `session.stats` is a **function**: `JSON.stringify(session.stats)` is
`undefined`, which looks exactly like "nothing fired".

`matched > 0` with no effects means the rule saw traffic and its firing policy
declined (a scheduled `pass`, a probability that didn't roll, or `suppressed`:
a rule ahead of it answered first). `matched === 0` means your pattern is wrong
— the most common cause of a fault test that passes for no reason.
`report.heldRequests` counts requests parked by an unbounded `hang`; it is a
report field, not a per-rule one, and a `hang` with `releaseAfterMs` is not
counted in it.

## Runtime faults

The kinds that cannot come from a route, because the `fetch()` call itself has
to fail:

| kind | what the app sees |
|---|---|
| `reject-fetch` | `fetch()` rejects — `TypeError`, or `DOMException` `AbortError` with `rejectAs: "AbortError"` |
| `never-settle-fetch` | the promise never settles, *unless* the caller passes `init.signal` — then it rejects with the signal's reason |
| `reject-body` | the fetch resolves and `res.json()` rejects. The most commonly missed `catch` in real code |
| `resolve-rejected-thenable` | resolves with a thenable that rejects |

`never-settle-fetch` honouring `init.signal` is deliberate: an app that bounds
its requests survives, so the fault only catches an app that *cannot* cancel.
Without that, the fault would report correct code as broken.

Runtime rules also take `methods: ["POST"]` — needed whenever one URL hosts more
than one operation.

## Deterministic schedules

On any rule, in place of (or alongside) `probability`:

```js
schedule: { decisions: ["pass", "inject", "pass"], afterEnd: "pass" }
```

Indexed by how many times *that rule* already matched. `afterEnd` decides
everything past the table. Consumes no randomness, so adding a schedule cannot
shift an existing seed's behaviour.

One thing to know if you rely on seeds: a rule with `probability: 0` no longer
consumes a random draw (it short-circuits). That is a change from older
versions, and it shifts the sequence for configs that had one.

## Invariants

An invariant is a function that inspects the page and returns a problem, or
nothing. This is where your oracle lives, so it is worth more care than the
faults themselves — see the main SKILL.md on the four ways an oracle passes
without checking anything.

## Driving a known path instead of a random one

```ts
import { chaos, flowDriver } from "chaosbringer";

await chaos({
  baseUrl,
  driver: flowDriver({
    steps: [
      { name: "open", urlPattern: /\/$/, run: async (page) => page.click("#open") },
      { name: "save", urlPattern: /\/$/, run: async (page) => page.click("#save") },
    ],
  }),
  faultInjection: [ … ],
});
```

The default driver picks actions by weighted random, which is right for
exploring and wrong for a claim: a fault test that cannot name the button
pressed cannot say what failed. `flowDriver` runs your steps in order, waiting
on pages a step's `when`/`urlPattern` does not claim. `compositeDriver([flowDriver(steps), weightedRandomDriver()])`
gets both — the flow on its path, random exploration everywhere else.

**It is one-shot, and it is stateful.** Once every step has completed the driver
returns null forever, so a second `chaos()` call handed the *same instance*
performs no actions at all — a run with `matched: 0` that looks exactly like a
wrong `urlPattern`. Build a fresh driver per run. (This one cost somebody an
hour, and the only thing that caught it was asserting the fault had fired.)

## Faults on a page you drive yourself

```ts
import { applyFaults, faults } from "chaosbringer";

const session = await applyFaults(page, {
  network: [
    faults.status(503, {
      name: "save-503",
      urlPattern: /\/api\/save$/,
      methods: ["POST"],
      schedule: { decisions: ["inject", "pass"] },
    }),
  ],
  runtime: [
    faults.rejectBody({ name: "body-unreadable", urlPattern: /\/api\/save$/, methods: ["POST"] }),
  ],
  seed: 1,          // only matters for `probability`; a schedule needs no randomness
});
await page.goto(url);   // runtime faults install as an init script — navigate AFTER applying
```

**Mind the two vocabularies.** In `chaos()` / `ChaosCrawler` the option names
are `faultInjection` and `runtimeFaults`; here they are `network:` and
`runtime:`. Same objects, different keys. And the layers are not
interchangeable: a fault built by `faults.rejectBody()` / `rejectFetch()` /
`neverSettleFetch()` carries an `action` and belongs under `runtime:`, while
`faults.status()` / `delay()` / `abort()` / `hang()` carry a `fault` and belong
under `network:`. Passing one to the other's key is refused with a message
naming the fix, so you will not spend an afternoon on
`Cannot read properties of undefined (reading 'kind')`.

`applyFaultRules(page, rules)` is a shorthand for `applyFaults(page, { network:
rules })` — note the different argument shape: a bare array, not an object.
It cannot take runtime faults.

| On the session | |
|---|---|
| `stats()` | network rules: `{ rule, matched, injected, suppressed? }[]`, live |
| `runtimeStats()` | runtime faults: `Promise<{ rule, matched, fired, suppressed? }[]>`, read out of the page |
| `firings()` | `Promise<Firing[]>` — both layers in one shape: `{ name, layer, matched, fired, suppressed, errored, counted }`. `layer` is `"network" \| "runtime" \| "lifecycle" \| "iframe"`; `counted` is false when the source row carried no usable counters, which is how you tell "nothing happened" from "nothing was measured" |
| `heldRequests()` | requests currently parked by an unbounded `hang` |
| `release()` | abort the parked ones, so the app's `catch` runs |
| `dispose()` | release, then remove the route — page talks to the real origin again |

`unfiredFaults` works on a session too, and is a better assertion than a
number, because it says *which* of the two failures you have:

```ts
const problems = unfiredFaults({
  faultInjections: session.stats(),
  runtimeFaults: await session.runtimeStats(),
});
if (problems.length > 0) throw new Error(problems.join("\n"));
```

`firings()` and `runtimeStats()` return **arrays**, in the order you passed the
faults, and each row is labelled by the `name` you gave the fault — so give
them names, or an unnamed network rule is labelled with its stringified regex.
Both are safe to call after `dispose()`: the counters are snapshotted on the way
out, because a post-teardown read that returned zeros would be
indistinguishable from "the fault never fired".

Your own `page.route` coexists with the applier's `**/*` route: the applier
calls `route.fallback()` for anything no rule claims, which hands the request to
the next matching handler — so a `page.route("**/app.js", …)` override serving a
fixed variant works whether you register it before or after `applyFaults`.

No crawl, no driver, no report: you navigate and click. The fault decision is
the crawler's own (`pickFaultRule`), so schedules and occurrence numbering mean
the same thing here. Nothing in this path uses exit codes or `strict` — those
belong to `chaos()`.

## Rejections the app let escape

```ts
import { watchUnhandledRejections } from "chaosbringer";

const rejections = await watchUnhandledRejections(page);  // before or after goto
await page.goto(url);
await page.click("#save");
// …wait settleMs…
const escaped = await rejections.drain();     // [] if the app handled everything
```

Installed both as an init script and against the document already open, so the
order does not matter and it survives navigation — one call covers a whole test.
(It used to be the init script only, which meant installing after `goto` left
nothing listening and `drain()` returned `[]` — the same answer a clean page
gives.) `drain()` empties as it reads, so a second probe after a quiescence
window reports only what is new, and it returns `[]` rather than throwing once
the page is closed — which is a read that could not happen, not a clean page.

It claims each rejection with `preventDefault()`, which matters: without that,
Chromium reports the same rejection a second time through
`page.on("pageerror")`, so a harness listening to both counts one escape as two
and files a rejection as a thrown exception. A real `throw` still reaches
`pageerror` normally.

## The package is ESM-only

`exports` declares `import` and no `require`, so from a directory without
`"type": "module"` you get `ERR_PACKAGE_PATH_NOT_EXPORTED`, which reads like a
broken install. Add `"type": "module"` to your `package.json`, or name the file
`.mjs` / `.mts`. And the test file has to sit where `chaosbringer` resolves — a
sibling directory of the app fails with `ERR_MODULE_NOT_FOUND`.

Assertions here are yours: the root API is framework-agnostic and works fine
under `node --test`. The `expect(...)` in these examples is illustrative, not a
dependency — `@playwright/test` is needed only for `chaosbringer/fixture`.

Worth knowing: **while any route is installed, Playwright disables the page's
HTTP cache.** A cacheable asset is re-fetched on every navigation until you
`dispose()`. It does not change the responses your rules serve, but it does
change request counts and adds ~20ms per navigation — so if your assertion
counts asset requests, or your window is tight, account for it.

## Playwright Test integration

```ts
import { chaosTest } from "chaosbringer/fixture";   // subpath, not the root

chaosTest("survives a failing cart", async ({ page, chaos }) => {
  const result = await chaos.testPage(page, "http://localhost:3000");
  expect(result.errors).toEqual([]);          // PageResult.errors — there is
});                                            // no `result.violations`
```

`chaosbringer/fixture` is the only entry point that needs `@playwright/test`
installed; the package root needs only `playwright`.

`testPage` uses a page *you* own, and releases anything a `hang` parked before
it returns. If you drive the page across several steps of your own, `release()`
on the crawler drains on demand.
