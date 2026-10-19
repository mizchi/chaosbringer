# Which fault layer for which bug

chaosbringer ships **four** browser-side fault layers plus a sibling package
for the **server side**. They overlap on purpose — pick by *where the bug
you want to surface lives*.

## Decision table

| You want to test… | Use | Why |
|---|---|---|
| Retry / timeout policy when an API returns 500 | `faults.status()` (`faultInjection`) | Cheapest — intercept at the route, server never sees the request. |
| Network failure (DNS, connection drop) | `faults.abort()` | Same layer; produces `requestfailed` events. |
| Backend slow / queue-depth issues from the client's POV | `faults.delay()` | Layer at the route; server sees the original request after the delay. |
| `fetch()` itself rejects, never settles, or its body fails to parse, even with a good server | `runtimeFaults` | In-page patch of `window.fetch` via `addInitScript`. Catches "the SDK swallowed the error". |
| Token expiry / clock drift | `runtimeFaults` (`clock-skew`) | Skews `Date.now()` / `performance.now()` — these only exist in the page context. |
| Storage wiped or tampered, Service Worker cache evicted, CPU throttled — at a named stage of a page visit | `lifecycleFaults` | One-shot actions tied to the visit's stages. **Only honoured by `chaos()` — `scenarioLoad()` ignores them.** |
| A third-party iframe (ad, widget, checkout) that loads late, never loads, or is removed mid-load | `iframeFaults` | Patches the iframe element's `src`, so the fault hits the load as the host page sees it. |
| Server-internal failure (DB timeout, retry exhaustion, OTel span) | `@mizchi/server-faults` (separate package) | Runs **inside** the server. Joins chaosbringer's report by W3C `traceparent`. |

## Network — `faults.*` (the most common one)

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  faultInjection: [
    faults.status(500,  { urlPattern: /\/api\//, probability: 0.1, name: "api-500" }),
    faults.delay(2000,  { urlPattern: /\/api\/checkout$/, probability: 1, methods: ["POST"] }),
    faults.abort({ urlPattern: /\.png$/, probability: 0.05 }),
  ],
});
```

- `urlPattern` accepts `RegExp` or regex `string`.
- `methods` is optional; omit to match any method.
- `probability` defaults to `1` (every match injects).
- `name` is what shows up in `report.faultInjections` and (for `scenarioLoad`)
  in the timeline `fault:<name>` sparkline row. **Set it** — the defaults
  (the pattern's source in the report, `fault-0` / `fault-1` on the
  timeline) are unreadable in CI logs.
- Behind a service worker, a rule sees the worker's own request (`resourceType`
  `"fetch"`) on a crawl's context, but nothing the worker answers from its
  cache, and nothing it takes on `testPage()` in your context. A page's
  `serviceWorker` field says which; a runtime fault fires ahead of the worker
  either way.

## Runtime — `runtimeFaults` (in-page monkey patches)

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  runtimeFaults: [
    {
      action: { kind: "reject-fetch", rejectAs: "TypeError", rejectionMessage: "patched fetch rejected" },
      urlPattern: /\/api\/slow-endpoint/,
      probability: 0.2,
      name: "fetch-rejects",
    },
    // fetch resolves, then res.json() rejects
    faults.rejectBody({ urlPattern: /\/api\//, probability: 0.1 }),
  ],
});
```

- Kinds: `reject-fetch` (`rejectAs: "TypeError" | "AbortError"`),
  `never-settle-fetch`, `reject-body`, `resolve-rejected-thenable`,
  `clock-skew` (`skewMs`), and the deprecated `flaky-fetch`. Each has a helper:
  `faults.rejectFetch()`, `faults.neverSettleFetch()`, `faults.rejectBody()`,
  `faults.rejectedThenable()`, `faults.clockSkew()`.
- Stats appear in `report.runtimeFaults` (totals; v1 has no per-fire timestamps).
- Patches `window.fetch` only — not `XMLHttpRequest`, not WebSocket. The fetch
  kinds match `urlPattern` against the string handed to `fetch()`;
  `clock-skew` matches `location.href` once per page load.

## Lifecycle — `lifecycleFaults` (one-shot at named stages)

Only useful with the `chaos()` crawler — `scenarioLoad()` ignores them
because step boundaries don't map to page lifecycle stages.

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  lifecycleFaults: [
    {
      when: "afterLoad",
      action: { kind: "clear-storage", scopes: ["localStorage", "sessionStorage"] }, // wipe storage once loaded
      urlPattern: /\/checkout/,
      probability: 0.5,
    },
    faults.cpu(4, { name: "cpu-4x" }), // 4× CPU throttle, from beforeNavigation
  ],
});
```

- `when`: `beforeNavigation` (before `page.goto`, so the load itself is
  affected), `afterLoad` (after navigation, before `afterLoad` invariants),
  `beforeActions` (after those invariants, before the first chaos action),
  `betweenActions` (after every chaos action).
- Kinds: `cpu-throttle` (`rate` ≥ 1), `clear-storage` (`scopes`:
  `localStorage` / `sessionStorage` / `cookies` / `indexedDB`), `evict-cache`
  (Service Worker `caches`; optional `cacheNames`), `tamper-storage` (`scope`,
  `key`, `value`). Helpers `faults.cpu()`, `faults.clearStorage()`,
  `faults.evictCache()`, `faults.tamperStorage()` each pick a default `when`.
- There is no offline, navigate-away or page-close action. To run a whole
  crawl offline, use the `network: "offline"` option (`--network offline`).
- Stats appear in `report.lifecycleFaults` (`matched` / `fired` / `errored`).

## Server — `@mizchi/server-faults` (different package)

When the bug only reproduces *inside* the server (DB pool exhausted, retry
storm, OTel span anomaly), the browser side can't help. Mount `@mizchi/server-faults`
in the server and set `server: { mode: "remote" }` on `chaos()` so the
fault events join the chaosbringer report via `traceparent`.

See [`docs/recipes/server-side-correlation.md`](../recipes/server-side-correlation.md) for the full pattern.

## Layering — combining them

These compose freely in one call:

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  faultInjection:  [faults.status(500, { urlPattern: /\/api\//, probability: 0.1 })],
  runtimeFaults:   [faults.rejectFetch({ urlPattern: /\/api\/search/, probability: 0.05 })],
  lifecycleFaults: [faults.clearStorage({ scopes: ["localStorage"], when: "betweenActions", probability: 0.2 })],
  server: { mode: "remote" },          // pick up @mizchi/server-faults headers
});
```

The fault stats land in separate fields on the report:
`report.faultInjections` (network), `report.runtimeFaults` (runtime),
`report.lifecycleFaults` (lifecycle), `report.iframeFaults` (iframe), plus
`report.serverFaults` if remote-mode picked up headers.

## Gotchas

- A `faults.status(500)` does **not** show up in your server-side OTel —
  the request was intercepted before reaching the server. If you need
  server traces, you need `@mizchi/server-faults`.
- `probability` is independent per match — three rules with `probability: 0.5`
  matching the same request roll three dice (and the first that hits wins).
- The "common confusion" callout in the main README is exactly this issue —
  don't be the third person to file the same bug.

## Related

- Feature docs: top-level [`README.md`](../../README.md) "Where each package fits" table.
- Server-side correlation: [`docs/recipes/server-side-correlation.md`](../recipes/server-side-correlation.md)
