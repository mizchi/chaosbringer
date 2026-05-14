# Which fault layer for which bug

chaosbringer ships **three** browser-side fault layers plus a sibling package
for the **server side**. They overlap on purpose — pick by *where the bug
you want to surface lives*.

## Decision table

| You want to test… | Use | Why |
|---|---|---|
| Retry / timeout policy when an API returns 500 | `faults.status()` (`faultInjection`) | Cheapest — intercept at the route, server never sees the request. |
| Network failure (DNS, connection drop) | `faults.abort()` | Same layer; produces `requestfailed` events. |
| Backend slow / queue-depth issues from the client's POV | `faults.delay()` | Layer at the route; server sees the original request after the delay. |
| Browser-side `fetch`/`XHR` behaves oddly even with a good server | `runtimeFaults` | In-page JS monkey patch via `addInitScript`. Catches "the SDK swallowed the error". |
| The page should still render when the DOM mutation observer / IntersectionObserver fails | `runtimeFaults` | Same — these only exist in the page context. |
| A specific Playwright lifecycle stage (page close mid-flight, focus loss, offline toggle) | `lifecycleFaults` | One-shot actions tied to navigation phases. **Only honoured by `chaos()` — `scenarioLoad()` ignores them.** |
| Server-internal failure (DB timeout, retry exhaustion, OTel span) | `@mizchi/server-faults` (separate package) | Runs **inside** the server. Joins chaosbringer's report by W3C `traceparent`. |

## Network — `faults.*` (the most common one)

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "...",
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
- `name` is what shows up in `report.faultInjectionStats` and (for `scenarioLoad`)
  in the timeline `fault:<name>` sparkline row. **Set it** — the default
  `fault-0` / `fault-1` is unreadable in CI logs.

## Runtime — `runtimeFaults` (in-page monkey patches)

```ts
await chaos({
  baseUrl: "...",
  runtimeFaults: [
    {
      action: { kind: "throw", message: "patched fetch threw" },
      urlPattern: /\/api\/slow-endpoint/,
      probability: 0.2,
      name: "fetch-throws",
    },
  ],
});
```

- Stats appear in `report.runtimeFaults` (totals; v1 has no per-fire timestamps).
- Works on `fetch` and `XMLHttpRequest`. Not WebSocket.

## Lifecycle — `lifecycleFaults` (one-shot at named stages)

Only useful with the `chaos()` crawler — `scenarioLoad()` ignores them
because step boundaries don't map to page lifecycle stages.

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "...",
  lifecycleFaults: [
    {
      stage: "domcontentloaded",
      action: { kind: "navigate", to: "about:blank" }, // navigate away mid-load
      urlPattern: /\/checkout/,
      probability: 0.5,
    },
  ],
});
```

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
  baseUrl: "...",
  faultInjection:  [faults.status(500, { urlPattern: /\/api\//, probability: 0.1 })],
  runtimeFaults:   [{ action: { kind: "throw" }, urlPattern: /sdk\.js/, probability: 0.05 }],
  lifecycleFaults: [{ stage: "load", action: { kind: "offline", durationMs: 500 } }],
  server: { mode: "remote" },          // pick up @mizchi/server-faults headers
});
```

The fault stats land in three separate fields on the report:
`report.faultInjectionStats` (network), `report.runtimeFaults` (runtime),
`report.lifecycleFaultStats` (lifecycle), plus `report.serverFaults` if
remote-mode picked up headers.

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
