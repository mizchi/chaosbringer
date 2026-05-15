# @mizchi/server-faults

Framework-agnostic server-side fault injection (5xx + latency + abort + partial response + slow streaming + status flapping) for Web Standard `Request` / `Response`. Sits between network-side fault interception (outside the server) and any client-side mocking. Independent of any HTTP framework — wire it as a 1-2 line middleware.

## Install

```bash
pnpm add @mizchi/server-faults
```

Requires Node 20+ (uses `Response.json` and the global `Request` constructor).

## Usage

The core `serverFaults({...})` is framework-agnostic. For one-line wiring, prefer the subpath adapters below — they are zero-cost wrappers that handle request/response translation. Reach for the core API only when you need finer control or your framework isn't on the list.

### Hono (Cloudflare Workers / Node)

```ts
import { Hono } from "hono";
import { honoMiddleware } from "@mizchi/server-faults/hono";

const app = new Hono();
app.use("*", honoMiddleware({
  status5xxRate: Number(process.env.CHAOS_5XX_RATE ?? 0),
  latencyRate: Number(process.env.CHAOS_LATENCY_RATE ?? 0),
  latencyMs: { minMs: 50, maxMs: 500 },
  pathPattern: "^/api/",
}));
```

### Express

```ts
import express from "express";
import { expressMiddleware } from "@mizchi/server-faults/express";

const app = express();
app.use(expressMiddleware({ status5xxRate: 0.05, pathPattern: /^\/api\// }));
```

### Fastify

```ts
import Fastify from "fastify";
import { fastifyPlugin } from "@mizchi/server-faults/fastify";

const app = Fastify();
await app.register(fastifyPlugin({ status5xxRate: 0.05, pathPattern: /^\/api\// }));
```

### Koa

```ts
import Koa from "koa";
import { koaMiddleware } from "@mizchi/server-faults/koa";

const app = new Koa();
app.use(koaMiddleware({ status5xxRate: 0.05, pathPattern: /^\/api\// }));
```

### Core API (any framework)

```ts
import { serverFaults } from "@mizchi/server-faults";

const fault = serverFaults({ status5xxRate: 0.05, pathPattern: /^\/api\// });
const response = await fault.maybeInject(webStandardRequest);
if (response) {
  // synthetic Response — short-circuit the handler
} else {
  // null — let the request through
}
```

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `status5xxRate` | `number` (0..1) | `0` | Probability of synthetic 5xx response |
| `status5xxCode` | `500 \| 502 \| 503 \| 504` | `503` | Status to return when the 5xx raffle wins |
| `statusFlapping` | `{ code?, windowMs, badMs, phaseOffsetMs? }` | none | Windowed 5xx: the first `badMs` of each `windowMs` period returns 5xx. Composes with `status5xxRate` via OR. Time-based, so **not seed-reproducible** |
| `latencyRate` | `number` (0..1) | `0` | Probability of injected latency |
| `latencyMs` | `number \| {minMs, maxMs}` | — | Sleep duration. Number = constant; range = uniform pick |
| `abortRate` | `number` (0..1) | `0` | Probability of tearing down the connection without sending a response. Rolled before 5xx / latency — wins short-circuit both |
| `abortStyle` | `"hangup" \| "reset"` | `"hangup"` | `hangup` = clean half-close (EOF). `reset` = forced reset (ECONNRESET) |
| `partialResponseRate` | `number` (0..1) | `0` | Probability of truncating the response body after `partialResponseAfterBytes`. **Hono adapter only** — Express / Koa / Fastify throw at construction if set |
| `partialResponseAfterBytes` | `number` | `0` | Bytes of the real response body to emit before EOF |
| `slowStreaming.rate` | `number` (0..1) | `0` | Probability of slow-streaming the response body. **Hono adapter only** |
| `slowStreaming.chunkDelayMs` | `number` | — | Milliseconds to sleep before each emitted chunk |
| `slowStreaming.chunkSize` | `number` | — | Optional: rechunk the body to fixed-size pieces before delaying. Omit to preserve source chunking |
| `pathPattern` | `RegExp \| string` | none | Only matching paths are considered for fault injection |
| `exemptPathPattern` | `RegExp \| string` | none | Paths that match are passed through unconditionally — useful for health checks or seed endpoints. Wins over `pathPattern`. |
| `bypassHeader` | `string` | none | Header name (case-insensitive). Any request that carries it is passed through unconditionally — useful for warm-up / fixture traffic in tests. |
| `seed` | `number` | none (`Math.random`) | When given, fault selection is reproducible across runs |
| `observer.onFault` | `(kind, attrs) => void` | none | Telemetry callback |

### Bypass and exempt — when to use which

- **`bypassHeader`** is opt-in **per request**. The caller (test runner, fixture script, internal monitor) attaches the header to mark "this one is mine, don't break it." Headers don't show up in the URL, so it is safe for shared paths.
- **`exemptPathPattern`** is opt-out **by URL**. It carves out a region of the surface that the caller cannot touch (e.g. `^/api/health`). Use this for paths that should *never* see chaos regardless of who calls them.
- Both fire **before** any raffle, so they are zero-cost on exempt traffic and they do not invoke `observer.onFault`.

## Semantics

- `null` = no fault, continue normally; `Response` = synthetic response, skip the handler.
- All fault kinds are **mutually exclusive in the same request**. Roll order is `abort → statusFlapping → 5xx → partial → slowStream → latency`; the first one that wins short-circuits the rest. Single-fault-per-request keeps observability data clean.
- `seed` drives **fault selection** (which raffles win), not exact ms values inside a `latencyMs` range — the inner range pick uses `Math.random()` so config tweaks don't shift the RNG sequence.
- **abort caveat**: the connection is torn down before any bytes can be sent, so `metadataHeader` cannot round-trip on the abort path. `observer.onFault` is the only observability channel. Express / Fastify / Koa call `socket.end()` (hangup) or `socket.destroy(err)` (reset) on the underlying Node socket. Hono throws `ServerFaultsAbortError` — runtimes propagate it as a connection error; Node-hosts can install an `onError` handler that translates it to a TCP-level teardown.

## Comparison with related layers

| Layer | Library | Where the fault is applied |
|---|---|---|
| Network | `chaosbringer` `FaultRule` | Playwright `route()` between browser and server |
| Page / lifecycle | `chaosbringer` `lifecycleFaults` | Browser DOM / storage / CPU |
| **Server** | **`@mizchi/server-faults`** | **Inside the server process before the handler** |

## Observability example

```ts
const fault = serverFaults({
  status5xxRate: 0.1,
  observer: {
    onFault: (kind, attrs) => {
      // wire to OTel / Datadog / console — no framework dep imposed by this lib
      faultsCounter.add(1, {
        kind,
        path: attrs["fault.path"],
        method: attrs["fault.method"],
      });
    },
  },
});
```

### Semantic conventions for `attrs`

`observer.onFault(kind, attrs)` passes a strongly-typed `FaultAttrs` object whose keys follow OTel-style `fault.*` naming so dashboards / pipelines can be reused across consumers.

| Attribute | Type | Required | Notes |
|---|---|---|---|
| `fault.kind` | `"5xx" \| "latency" \| "abort" \| "partial" \| "slowStream"` | always | mirrors the `kind` arg, so the attrs object is self-describing |
| `fault.path` | `string` | always | URL pathname (no host, no query) |
| `fault.method` | `string` | always | HTTP method, uppercased |
| `fault.target_status` | `number` | when `kind === "5xx"` | the synthetic HTTP status returned |
| `fault.latency_ms` | `number` | when `kind === "latency"` | milliseconds actually slept |
| `fault.abort_style` | `"hangup" \| "reset"` | when `kind === "abort"` | how the connection was torn down |
| `fault.after_bytes` | `number` | when `kind === "partial"` | bytes of the real body emitted before truncation |
| `fault.chunk_delay_ms` | `number` | when `kind === "slowStream"` | milliseconds slept between chunks |
| `fault.chunk_size` | `number` | when `kind === "slowStream"` and configured | rechunked output size |

The shape is part of the public contract: additions are backward-compatible, renames are not. This is why we shipped a stable schema before any consumer pinned to ad-hoc keys.

## License

MIT
