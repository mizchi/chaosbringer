# @mizchi/kitesurf-faults on a real workerd + Kitesurf

A host Worker embeds [Kitesurf](https://github.com/mizchi/kitesurf) through
its public `@kitesurf/engine/embed` surface and gives every CDP connection a
`ChaosEgress` Service Binding as `EngineHost.egress`. That binding runs the
connection's requests through a `createFaultEgress` session owned by a test
run, after the engine has applied its URL filter, CORS, cookies and
private-network checks.

The first scenario is the issue's first example: `GET /api/cart` gets a 503
once and then reaches the real server. The oracle checks the page's DOM, the
session's stats and the server's call count together:

```
correct fixture  /correct/  attempts 503,200  result ok:3   matched 2 injected 1  upstream /api/cart 1  -> pass
broken fixture   /broken/   attempts 503      result failed matched 1 injected 1  upstream /api/cart 0  -> fails the same oracle
```

## Run it

You need Node 24+, pnpm, and a Kitesurf checkout at the pinned revision with
its assets built. The pin, the asset list and the build command are in
[kitesurf-revision.json](./kitesurf-revision.json).

```sh
# in the Kitesurf checkout, at the pinned revision
git checkout 58d10e608692f20de9cd2ae3c05d8f7a082aecae
pnpm install --frozen-lockfile && pnpm run build   # = bazel run //packages/engine:dev_build

# in this repository
pnpm install
pnpm -F @mizchi/playwright-faults build && pnpm -F @mizchi/kitesurf-faults build
KITESURF_DIR=/path/to/kitesurf pnpm -F @mizchi/chaosbringer-example-kitesurf-faults test:integration

# or both steps at once, from the repository root
KITESURF_DIR=/path/to/kitesurf just kitesurf-faults-integration
```

`pnpm test` here runs only the unit tests: the oracle, the log gate, the run
registry and the `KITESURF_DIR` checks. It needs no Kitesurf checkout.

The runner stops before it starts anything, with exit code 2, if any of these
is true:

- `KITESURF_DIR` is unset. The run fails; it is not reported as skipped.
- The checkout is not a git checkout, or it is at a different revision. Set
  `KITESURF_REV=<sha>` to accept another revision; the artifact records the
  override.
- Tracked files in the checkout are modified.
- A built asset is missing. The runner lists each missing file and prints the
  build command.
- Node is older than 24, `@mizchi/kitesurf-faults` is not built, or
  `wrangler.jsonc` lost the `enable_request_signal` flag.

When the checks pass, it links `node_modules/@kitesurf/engine` and
`.kitesurf/public` into the checkout. Both are absolute links, made on every
run and git-ignored. It then starts Kitesurf's own wrangler
(`packages/engine/node_modules/.bin/wrangler`) on 127.0.0.1 with a free port,
runs the scenarios, and stops the process group it started and nothing else.

It writes `artifacts/kitesurf-integration.json` with every scenario's
expectation, result, stats and upstream counts, plus:

- the chaosbringer and Kitesurf revisions, and Kitesurf `origin/main` as last
  fetched;
- the wrangler, workerd and Node versions;
- the compatibility date and flags;
- the log-gate verdict.

The workerd log goes to `artifacts/wrangler.log`.

The exit code is 0 only when all of these hold:

- every scenario met its expectation;
- every run was torn down completely: stats fetched, socket closed, session
  disposed, no egress call still in flight, `session_end` seen;
- the log gate found no unexpected error;
- the control token does not appear in the log.

## Scenarios

| | What it shows | Expected |
| --- | --- | --- |
| S1 | `/correct/` recovers from the injected 503: `503,200`, `ok:3`, matched 2 / injected 1, upstream cart 1 | pass |
| S2 | `/broken/` under the same rules and oracle; the run must also show why: attempts `503`, `failed`, injected 1, upstream cart 0 | oracle fails with `dom-mismatch` |
| S3 | a rule for `/api/does-not-exist`: the page shows `ok:3`, yet no fault fired (matched 0, upstream cart 1) | oracle fails with `not-injected` |
| S4 | two runs at once: each one's first cart call gets the 503, and their counters stay apart | pass |
| S5 | in the same run: a `Runtime.evaluate` fetch, a re-navigation (the counts continue, no new 503), a page WebSocket (the loaded worker's `globalOutbound` path) and a dedicated worker's fetch | pass |
| S6 | an `abort` fault: the page's fetch rejects with `TypeError` (not an HTTP 503) and upstream is never called | pass |
| S7 | a URL rejected by `Kitesurf.setOutboundFilters` gets 451 and never reaches egress, even though a rule would fault it every time | pass |
| S8a | after dispose: reconnecting gets 409, connecting without a run gets 400, and a second dispose gets 200 | pass |
| S8c | a second socket on a live run gets 409, and the run's counters do not move | pass |
| S8b | the run is deleted while its socket is open: the page's fetch fails and the navigation's `errorText` says `run-lost` | pass |
| S9a | a 300 ms delay: the page waits at least 300 ms, then upstream is called once | pass |
| S9b | a 4 s delay, and the CDP socket closes at 0.8 s: `Request.signal` fires, the wait ends, and upstream is still 0 after 5 s | pass |
| S9c | a 4 s delay, and the host disposes the run at 0.8 s while the socket is open: the page's fetch rejects early and upstream stays 0 | pass |

## Design notes and constraints

- **The session lives in host memory, and the binding carries only the run id.**
  Service Binding props must be serializable, so neither a `FaultEgressSession`
  nor a `fetch` closure can go in them. A closure returned as egress fails when
  the engine clones it into the page isolate. `src/registry.ts` keeps at most 8
  runs and sweeps any run older than 10 minutes. A lookup that fails is
  `run-lost`, an error; it never falls back to a new session or a
  pass-through.
- **The run is bound at the WebSocket upgrade.** `EngineHost.egress(env, ctx)`
  receives neither the request nor the connection id, so `ChaosHost` reads
  `?run=<id>` from `/devtools/browser?run=<id>`. The engine creates egress
  once per connection, so a run spans every navigation of its connection.
  A run accepts one connection for its whole life: a second upgrade, or a
  reconnect after the first socket closed, gets 409, so two connections never
  share a run's counters and RNG.
  Only the harness ends a run, in its `finally`; the host only records
  `session_end` from telemetry.
- **`enable_request_signal` is required.** Without it, a Service Binding call
  that its caller abandons, through the engine's 10 s egress deadline or a
  closed socket, has a `Request.signal` that never fires. workerd drops its
  context silently. The delay timer then leaks, and a host-side dispose
  cannot reach the call.
- **A page-side `AbortController` does not reach egress.** Kitesurf's session
  fetch path rebuilds the Request without the page's signal. If the page
  aborts during a delay, egress still waits out the delay and calls upstream.
  The package's unit tests cover cancellation through `Request.signal`; here,
  S9b and S9c cover the engine-side close and the host-side dispose.
- **The control plane** (`/__chaos/*`) requires a per-run random token. The
  runner passes the token through a private `--env-file`, not `--var`,
  because wrangler prints `--var` values. Pages cannot reach the control
  plane: their requests go to egress and the in-isolate fixture, and the
  engine refuses loopback.
- **The log gate** (`src/log-gate.ts`) fails the run on any `Uncaught`,
  `[ERROR]` or `Error:` line it cannot account for. The lines it accounts for
  are:
  - Kitesurf's per-navigation isolate teardown and the CDP-close line;
  - the injected-abort marker, which must reconcile with the injected count;
  - `run-lost` for the run S8b deletes;
  - the disposed-session error and the caller-cancelled marker, when the
    stats show the matching cut-short call.

  The allowlist belongs to the pinned Kitesurf revision.
- **What reaches egress.** Every engine fetch goes through egress, including
  the top-level document, scripts, preflights and redirects. That is why the
  rules match a full URL and a method.
- **Performance metrics.** Kitesurf has no Performance or Tracing domain at
  this revision, so this example reports no performance metrics.
