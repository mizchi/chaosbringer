# @mizchi/server-faults

Framework-agnostic server-side fault injection (5xx + latency) for Web Standard `Request` / `Response`. Sits between network-side fault interception (outside the server) and any client-side mocking. Independent of any HTTP framework — wire it as a 1-2 line middleware.

## Install

```bash
pnpm add @mizchi/server-faults
```

Requires Node 20+ (uses `Response.json` and the global `Request` constructor).

## Usage

### Hono on Cloudflare Workers / Node

```ts
import { Hono } from "hono";
import { serverFaults } from "@mizchi/server-faults";

const fault = serverFaults({
  status5xxRate: Number(process.env.CHAOS_5XX_RATE ?? 0),
  latencyRate: Number(process.env.CHAOS_LATENCY_RATE ?? 0),
  latencyMs: { minMs: 50, maxMs: 500 },
  pathPattern: "^/api/",
});

const app = new Hono();
app.use("*", async (c, next) => {
  const response = await fault.maybeInject(c.req.raw);
  if (response) return response;
  return next();
});
```

### Express

```ts
import express from "express";
import { serverFaults } from "@mizchi/server-faults";

const fault = serverFaults({ status5xxRate: 0.05, pathPattern: /^\/api\// });

const app = express();
app.use(async (req, res, next) => {
  const webReq = new Request(`http://${req.headers.host}${req.originalUrl}`, {
    method: req.method,
  });
  const response = await fault.maybeInject(webReq);
  if (!response) return next();
  res.status(response.status);
  res.json(await response.json());
});
```

## Config

| Field | Type | Default | Notes |
|---|---|---|---|
| `status5xxRate` | `number` (0..1) | `0` | Probability of synthetic 5xx response |
| `status5xxCode` | `500 \| 502 \| 503 \| 504` | `503` | Status to return when the 5xx raffle wins |
| `latencyRate` | `number` (0..1) | `0` | Probability of injected latency |
| `latencyMs` | `number \| {minMs, maxMs}` | — | Sleep duration. Number = constant; range = uniform pick |
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
- 5xx and latency are **mutually exclusive in the same request**. If the 5xx raffle wins, the function returns immediately and the latency raffle is never rolled. Single-fault-per-request keeps observability data clean.
- `seed` drives **fault selection** (which raffles win), not exact ms values inside a `latencyMs` range — the inner range pick uses `Math.random()` so config tweaks don't shift the RNG sequence.

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
      faultsCounter.add(1, { kind, path: String(attrs.path) });
    },
  },
});
```

## License

MIT
