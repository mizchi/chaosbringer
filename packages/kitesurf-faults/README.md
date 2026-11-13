# @mizchi/kitesurf-faults

Runs chaosbringer's network `FaultRule`s on a `fetch(request): Promise<Response>` transport, such as the one [Kitesurf](https://github.com/mizchi/kitesurf) calls through its `EngineHost.egress` hook. A rule written for Chromium (`page.route`) means the same thing here: the same first-match order, the same occurrence counters and the same seeded draws.

Experimental and not published to npm yet. This first version supports three faults: an HTTP error response, a failed request, and a bounded delay.

## Where it sits

Kitesurf applies its own request policy (URL filter, CORS, cookies, private-network checks) and then hands the request to the host's transport. This session is that transport. A fault here is a fault in the network, so it does not bypass the engine's policy, and a request the engine refuses never reaches this session.

The package's runtime is Web-standard APIs plus `@mizchi/playwright-faults/network`, the Playwright-free rule decision. It loads no Playwright, no `node:*` module and no Kitesurf code, so a Worker bundle can include it.

## Usage

```ts
import { createFaultEgress } from "@mizchi/kitesurf-faults";

const session = createFaultEgress(
  { fetch: (request) => fetch(request) }, // the real upstream
  {
    seed: 42,
    rules: [
      {
        name: "cart-503-once",
        urlPattern: /^https:\/\/shop\.example\/api\/cart$/,
        methods: ["GET"],
        fault: { kind: "status", status: 503 },
        schedule: { decisions: ["inject"] }, // first GET gets 503, the retry goes through
      },
    ],
  },
);

const res = await session.fetch(new Request("https://shop.example/api/cart")); // 503
session.stats(); // [{ rule: "cart-503-once", matched: 1, injected: 1 }]
await session.dispose();
```

`createFaultEgress(upstream, options)` returns a `FaultEgressSession`, which has these methods:

| Member | |
| --- | --- |
| `fetch(request)` | Decides and runs the fault, or hands the request to `upstream` once |
| `stats()` | Per-rule `{ rule, matched, injected, suppressed? }`. Each call returns fresh objects, and it still works after `dispose()` |
| `dispose()` | Aborts pending delays and upstream calls in flight. Every later `fetch` rejects. Safe to call more than once |

These are the options:

| Option | |
| --- | --- |
| `rules` | `FaultRule[]` from `@mizchi/playwright-faults`. Checked and copied once; the caller's arrays and RegExps are never changed |
| `seed` | Required, an integer in `0..4294967295`. Used only by rules with `probability` |
| `maxDelayMs` | The largest `delay.ms` a rule may ask for, in `0..5000`. Default `5000` |

## What each fault does

| Rule outcome | Result |
| --- | --- |
| No rule matches, or the decision is `pass` | `upstream.fetch` is called once. URL, method, headers, body, credentials and redirect are kept, and the upstream `Response` is returned as it came, as a stream that has not been read |
| `status` (400–599) | A synthetic response; upstream is not called. When the rule gives no body, the body is `{"error":<status>}`; an explicit `""` stays empty. `content-type` defaults to `application/json`. These are the same defaults as the Playwright adapter |
| `abort` | Rejects with `KitesurfFaultsError` (`code: "injected-abort"`, message `kitesurf-faults: injected abort`); upstream is not called. This is a failed fetch, not an HTTP 5xx |
| `delay` | Waits `ms`, then calls upstream once. Aborting the request or disposing the session ends the wait, and then upstream is not called |

A synthetic response does not mean a real server failed, and no server-side span exists for it. `injected` counts the faults that were chosen. It does not prove that a page received the response.

## Refused at construction

`createFaultEgress` throws `KitesurfFaultsError` with `code: "invalid-config"` for each of these. The message names the rule.

- A `seed` that is not a uint32 integer, or a `maxDelayMs` outside `0..5000`.
- `status` outside 400–599, or a non-integer `status`.
- `abort.errorCode` other than `"failed"`. A Workers transport can fail a fetch, but it cannot reproduce Chromium's specific error codes.
- `delay.ms` that is negative, not finite, or over `maxDelayMs`. An over-limit delay is not clamped.
- `hang`, and any other fault kind.
- `resourceTypes` in any form, including `[]`. Kitesurf strips its `x-kitesurf-*` headers before egress, so the resource type is not known. It is never guessed from the extension or the `Accept` header.
- An invalid `urlPattern`, an empty `methods`, a `probability` outside 0..1, `probability` together with `schedule`, or an invalid `schedule`.

## Ordering, counters and cancellation

- The rule is picked and the counters advanced before the first `await`. When requests arrive concurrently, each gets its occurrence number in arrival order, whatever order their delays end in.
- A request whose signal is already aborted is rejected before the decision, so it is not counted.
- Counts are calls that reached this transport. Cached responses never reach it. Engine-side preflights and redirect hops do, so scope rules by URL and method.
- The engine's own request deadlines still apply. A delay followed by a slow upstream can still time out in the engine.
- Every request uses its own timer and abort listeners. They are removed in the callback that settles the request, not in a `finally` block: workerd can cancel a call's context without running code after an `await`.

On workerd, a Service Binding sees `Request.signal` fire only when the host Worker sets the `enable_request_signal` compatibility flag. Without the flag, the host has to call `dispose()` to end pending waits.

## Development

```sh
just pkg @mizchi/playwright-faults build   # this package resolves ./network through dist/
just pkg @mizchi/kitesurf-faults test
just pkg @mizchi/kitesurf-faults build
```

The unit tests use fake timers and do not need a Kitesurf checkout.
