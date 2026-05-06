# Correlate server-side faults with the chaosbringer report

`chaosbringer` injects faults at the Playwright route layer (between browser and server). `@mizchi/server-faults` injects them inside the server process. Without coordination they produce two unrelated streams: chaosbringer's `chaos-report.json` and the server's OTel telemetry. This recipe wires them together so a single chaos run produces one report covering both layers, joined by W3C `traceparent`.

## When you need this

- You run `pnpm chaos` and `wrangler dev` (or `node server.js`) as **separate processes** and want one unified report.
- You want to know "did the 503 in this report come from the chaos network layer (chaosbringer's `faults.status(500, …)`) or from inside the server (`@mizchi/server-faults`'s `status5xxRate`)?"
- You want to grep the resulting report by `traceId` and find every fault — network and server-side — that affected a single Playwright action.

## Architecture (Phase 1, separate-process mode)

```
Browser (Playwright)              Server process
  |                                  |
  |-- request, traceparent injected->|
  |   (chaosbringer adds it)         |-- @mizchi/server-faults rolls dice
  |                                  |     [synthetic 5xx]:
  |                                  |       response.headers +=
  |                                  |         x-chaos-fault-*
  |                                  |     [latency]:
  |                                  |       sleep, real handler runs,
  |                                  |       adapter adds headers
  |                                  |       on the way back
  |<--------- response (with --------|
  |                  fault headers)  |
  |
  page.on('response') fires
  prefix matches → parse attrs → push ServerFaultEvent
  |
report.serverFaults = [...events]
```

Two ingredients have to be wired together:

1. **chaosbringer injects `traceparent` on every request** it routes through Playwright (PR #72). The server-side middleware sees this header and stamps it on every fault it injects.
2. **`@mizchi/server-faults` mirrors fault metadata onto kebab-case response headers** (`x-chaos-fault-*`) when its `metadataHeader` option is set. chaosbringer parses those headers in a `page.on('response', …)` listener and surfaces the events on `CrawlReport.serverFaults`.

## Wiring it up

### Step 1 — server: enable `metadataHeader` on `@mizchi/server-faults`

The server-faults middleware turns its observer-callback events into response headers. Pick the adapter for your framework — the `metadataHeader` option works the same way in all four:

```ts
// Hono
import { honoMiddleware } from "@mizchi/server-faults/hono";

app.use("*", honoMiddleware({
  status5xxRate: Number(process.env.CHAOS_5XX_RATE ?? 0),
  latencyRate:   Number(process.env.CHAOS_LATENCY_RATE ?? 0),
  latencyMs:     Number(process.env.CHAOS_LATENCY_MS ?? 0),
  seed:          Number(process.env.CHAOS_SEED ?? 0),
  metadataHeader: true,            // <-- the load-bearing line
  bypassHeader:   "x-chaos-bypass", // optional, see `seeding-data.md`
}));
```

```ts
// Express
import { expressMiddleware } from "@mizchi/server-faults/express";
app.use(expressMiddleware({ status5xxRate: 0.3, metadataHeader: true }));

// Fastify
import { fastifyPlugin } from "@mizchi/server-faults/fastify";
await fastify.register(fastifyPlugin({ status5xxRate: 0.3, metadataHeader: true }));

// Koa
import { koaMiddleware } from "@mizchi/server-faults/koa";
app.use(koaMiddleware({ status5xxRate: 0.3, metadataHeader: true }));
```

After this change, every synthetic 5xx response and every latency-affected real response carries headers like:

```
x-chaos-fault-kind: 5xx
x-chaos-fault-path: /api/todos
x-chaos-fault-method: GET
x-chaos-fault-target-status: 503
x-chaos-fault-trace-id: 0af7651916cd43dd8448eb211c80319c
```

The default prefix is `x-chaos-fault`. To change it, pass `metadataHeader: { prefix: "x-my-fault" }` and feed the same prefix to chaosbringer below.

### Step 2 — chaosbringer: enable remote-server ingestion

```ts
import { chaos, faults } from "chaosbringer";

const { passed, report } = await chaos({
  baseUrl: "http://localhost:8787",
  seed: 42,
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.3 }),
  ],
  server: { mode: "remote" },        // <-- the load-bearing line
});

console.log(report.serverFaults);    // ServerFaultEvent[] | undefined
```

`server: { mode: "remote" }` attaches a `page.on('response', …)` listener that parses `x-chaos-fault-*` headers and accumulates events. After the crawl, `report.serverFaults` contains a flat array of:

```ts
interface ServerFaultEvent {
  traceId?: string;        // 32-hex, from the request's traceparent
  attrs: {
    kind: "5xx" | "latency";
    path: string;          // URL pathname (no host, no query)
    method: string;        // uppercase HTTP method
    targetStatus?: number; // set when kind === "5xx"
    latencyMs?: number;    // set when kind === "latency"
    traceId?: string;      // duplicated here for OTel-attribute parity
  };
  observedAt: number;      // Date.now() at the moment chaos saw the response
  pageUrl: string;         // page that triggered the request
}
```

The field is `undefined` when no events were observed (matches the `coverage` / `advisor` convention in `CrawlReport`).

To override the prefix:
```ts
server: { mode: "remote", responseHeaderPrefix: "x-my-fault" },
```

### Step 3 — share the chaos seed across both processes

Network and server-side fault layers use independent RNGs. Reproducibility means **every layer sees the same seed at process start**. Phase 1 pushes this onto the operator: pass the seed via env var to both processes.

```bash
export CHAOS_SEED=42

# server
CHAOS_5XX_RATE=0.3 CHAOS_SEED=$CHAOS_SEED node server.js &

# chaosbringer
SEED=$CHAOS_SEED pnpm chaos
```

The chaosbringer report's `Repro:` line includes only chaosbringer's own seed (the network-layer roll). The server-side seed is the operator's responsibility — write it next to the Repro line or in your run log.

## Verification

After a run with `CHAOS_5XX_RATE=0.3`:

```ts
const fivexx = report.serverFaults?.filter(e => e.attrs.kind === "5xx") ?? [];
console.log(`server-side 5xx: ${fivexx.length}`);

// join with chaosbringer actions by traceparent (when implemented in your stack):
for (const action of report.actions) {
  const trace = action.traceparent?.match(/^00-([0-9a-f]{32})/)?.[1];
  if (!trace) continue;
  const matchingFaults = report.serverFaults?.filter(e => e.traceId === trace) ?? [];
  if (matchingFaults.length > 0) {
    console.log(`action ${action.target} → ${matchingFaults.length} server fault(s)`);
  }
}
```

The `traceId` join is the load-bearing primitive: same `traceparent` on the wire → same value in `report.serverFaults[].traceId` → same value emitted on OTel attributes via `toOtelAttrs(attrs)` in any downstream observability layer.

## OTel exporter integration

If your server already pipes `@mizchi/server-faults` events into OTel via the `observer.onFault` callback, `toOtelAttrs(attrs)` translates the in-memory flat camelCase shape to the wire-level dotted attribute schema:

```ts
import { serverFaults, toOtelAttrs } from "@mizchi/server-faults";

const fault = serverFaults({
  status5xxRate: 0.3,
  metadataHeader: true,
  observer: {
    onFault: (kind, attrs) => {
      span.setAttributes(toOtelAttrs(attrs));
      // produces: { "fault.kind": "5xx", "fault.path": "/api/todos",
      //             "fault.method": "GET", "fault.target_status": 503,
      //             "fault.trace_id": "0af7651916cd…" }
    },
  },
});
```

Now any downstream OTel consumer (Jaeger, Tempo, Honeycomb, Datadog) can filter spans by `fault.kind="5xx"` or join chaos events to user spans by `fault.trace_id`.

## Limitations of Phase 1

- **Seed propagation is manual.** Future work may add automatic seed broadcast.
- **Same-process integration (`server: ServerFaultHandle`) is not implemented.** Phase 2 will let the test runner pass the handle directly, share an in-memory observer, and skip the response-header round-trip. Useful for unit tests where the test driver imports the app.
- **Per-action correlation is post-hoc.** `report.serverFaults` is a flat list; consumers join by `traceId` themselves. A trace-id-indexed dict on `ActionResult` is design-deferred.

## Related

- Spec: [`docs/superpowers/specs/2026-05-06-chaos-server-orchestration-design.md`](../superpowers/specs/2026-05-06-chaos-server-orchestration-design.md) (internal design rationale)
- Issue: [`#56`](https://github.com/mizchi/chaosbringer/issues/56)
- PR 1 (server-faults): [`#74`](https://github.com/mizchi/chaosbringer/pull/74)
- PR 2 (chaosbringer): [`#75`](https://github.com/mizchi/chaosbringer/pull/75)
- Seeding pattern: [`docs/recipes/seeding-data.md`](seeding-data.md)
