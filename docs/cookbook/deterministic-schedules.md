# Fail the first call, pass the retry

`probability` cannot express "fail occurrence 0, let occurrence 1 through" —
it rolls the dice on every match. `schedule` replaces the roll with a decision
table indexed by how many times the fault has already matched:

```ts
import { chaos, faults } from "chaosbringer";

const { report } = await chaos({
  baseUrl: "http://localhost:3000/checkout",
  maxPages: 1,
  maxActionsPerPage: 0,
  faultInjection: [
    faults.status(500, {
      urlPattern: /\/api\/cart$/,
      schedule: { decisions: ["inject", "pass"] }, // 1st call 500s, retry works
    }),
  ],
});
```

Now a retry test is a *test*, not a lucky run. Same field on all four layers
(`faultInjection`, `lifecycleFaults`, `runtimeFaults`, `iframeFaults`), and
`probability` + `schedule` together is a validation error.

## `afterEnd` — what happens past the table

```ts
{ decisions: ["inject", "pass"] }                      // spent: never fires again
{ decisions: ["pass"], afterEnd: "inject" }            // let the first through, break the rest
{ decisions: ["inject", "pass"], afterEnd: "repeat" }  // every other call fails
```

Default is `"pass"` (spent).

## Seeds stay stable

A schedule consumes no RNG, so adding one leaves the seed sequence — and
therefore chaos action selection — untouched. `--seed 42` still reproduces the
same crawl.

## Two outcomes on one endpoint

Faults watching the same URL share occurrence numbering, so you can hand
different occurrences to different fault kinds:

```ts
runtimeFaults: [
  {
    name: "cart-first-fails",
    urlPattern: /\/api\/cart$/,
    schedule: { decisions: ["inject", "pass", "pass"] },
    action: { kind: "reject-fetch", rejectAs: "TypeError" },
  },
  {
    name: "cart-third-hangs",
    urlPattern: /\/api\/cart$/,
    schedule: { decisions: ["pass", "pass", "inject"] },
    action: { kind: "never-settle-fetch" },
  },
]
```

Call 1 rejects, call 2 succeeds, call 3 never settles — a retry-then-stall
sequence in one run. (Don't split one endpoint across the *network* and
*runtime* layers this way: a client-side rejection issues no request, so the
network rule's counter never advances and the two tables drift apart.)

## Promise-shaped faults worth scheduling

| Fault | What it does | Bug it exposes |
|---|---|---|
| `faults.rejectFetch({ rejectAs: "AbortError" })` | `fetch` rejects with a `DOMException` | Code that treats every rejection as an outage and shows a retry banner on a user cancel |
| `faults.rejectBody()` | `fetch` resolves, `res.json()` rejects | The classic missed `catch`: guarded fetch, unguarded `await res.json()` |
| `faults.neverSettleFetch()` | promise never settles, no request issued | Missing timeout. `networkidle` still fires, so page load isn't blocked — the UI just never leaves loading |
| `faults.rejectedThenable()` | same rejection, one microtask later | Handlers attached too late |
| `faults.hang({ urlPattern, releaseAfterMs })` | request held open | Same as above for non-`fetch` requests (XHR, images, navigations) |

Unbounded `faults.hang()` (no `releaseAfterMs`) parks the route until page
teardown and shows up as `report.heldRequests`. Because the crawler navigates
with `waitUntil: "networkidle"`, a hang on a navigation-time request costs one
page `timeout` — prefer hanging what an action fires after load.

## Scaling up

Writing schedules by hand covers the cases you already suspect. To enumerate
*every* combination — and get told which ones are impossible — see
[Model-driven faults](../recipes/model-driven-faults.md).
