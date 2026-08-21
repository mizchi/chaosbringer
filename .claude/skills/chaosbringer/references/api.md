# chaosbringer API

Verified against the source. Where a signature here disagrees with the code,
the code wins — say so rather than working around it.

## Installing and running

```bash
pnpm add -D chaosbringer            # or npm/yarn
npx chaosbringer crawl --url http://localhost:3000 --seed 42
```

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
| `faults.status(500, { urlPattern })` | respond with that status; `body`, `contentType` optional |
| `faults.delay(ms, { urlPattern })` | respond, late. Always eventually responds |
| `faults.abort({ urlPattern, errorCode })` | the request fails at the network layer |
| `faults.hang({ urlPattern, releaseAfterMs })` | hold it open, never respond |
| `faults.cpu(rate)` | lifecycle: CPU throttling |

`faults.hang` without `releaseAfterMs` holds until the page closes. The crawler
navigates with `waitUntil: "networkidle"`, so hanging a *navigation-time*
request costs one page `timeout` — hang what an action fires after load, or pass
`releaseAfterMs`.

## The crawler

```js
import { ChaosCrawler, faults } from "chaosbringer";

const crawler = new ChaosCrawler({
  seed: 42,                       // reproducible; omit for random
  faultInjection: [ … ],          // network layer: FaultRule[]
  runtimeFaults: [ … ],           // in-page fetch patching: RuntimeFault[]
  lifecycleFaults: [ … ],         // visibility, offline, CPU: LifecycleFault[]
  invariants: [ … ],              // what must hold; see below
});
```

The report carries per-rule stats. Read the field names carefully, they are not
synonyms:

- `matched` — requests whose URL (and method) the rule matched.
- `injected` / `fired` — of those, the ones actually perturbed. A scheduled
  `pass` decision matches without injecting.
- `heldRequests` — requests parked by `hang`.

A rule with `matched > 0` and `injected === 0` means the rule saw traffic and
chose not to break it. A rule with `matched === 0` means your pattern is wrong —
that is the most common cause of a fault test that passes for no reason.

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

## Playwright Test integration

```js
import { ChaosCrawler } from "chaosbringer";

test("survives a failing cart", async ({ page }) => {
  const crawler = new ChaosCrawler({ faultInjection: [ … ] });
  const result = await crawler.testPage(page, "http://localhost:3000");
  expect(result.violations).toEqual([]);
});
```

`testPage` uses a page *you* own. Be careful with `hang` here: a request parked
on a page the caller still owns is not released by the crawler's own teardown,
so pass `releaseAfterMs` when you use `hang` through this entry point.
