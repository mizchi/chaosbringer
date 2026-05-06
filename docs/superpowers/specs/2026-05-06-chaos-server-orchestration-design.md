# Chaos × server-faults orchestration (C2 Phase 1)

**Date:** 2026-05-06
**Issue:** [chaosbringer#56](https://github.com/mizchi/chaosbringer/issues/56)
**Status:** Approved (awaiting implementation plan)

## Problem

`chaosbringer` injects faults at the **Playwright route layer** (between
browser and server). `@mizchi/server-faults` injects faults **inside the
server**. They are intentionally separate concerns, but today there is
no shared way to drive both from one chaos run:

- Server-side fault events live only in the server process. The chaos
  report has no record of them.
- The two layers' RNGs are seeded independently. Reproducing a "503 from
  network + slow server response" combo across runs requires the operator
  to align two seeds by hand.
- The user reads two separate observability surfaces (chaos report +
  whatever the server emits to OTel/Prometheus).

The most realistic chaos scenarios are *combined* — a 503 returned by the
network layer **and** the server is also degraded — and orchestrating
those compound failures across runs is the missing piece.

## Scope

This spec covers **Phase 1, separate-process mode** (option C2 in
brainstorming). The motivating consumer is `otel-chaos-lab`-shaped
deployments: `pnpm chaos` and the server (`wrangler dev`, Node, Deno,
Bun, …) run as **different processes**, communicating only over HTTP.

**In scope:**

- A new `server: { mode: "remote", … }` field on `chaos()` that lets the
  Playwright crawler ingest server-side fault events emitted by
  `@mizchi/server-faults`.
- Response-header-based event channel (server-faults annotates synthetic
  / latency-affected responses; chaos parses headers in
  `page.on('response', …)`).
- `fault.trace_id` joining the W3C `traceparent` already injected by
  chaosbringer's network layer (PR #72).
- A breaking `maybeInject` API change on server-faults to surface
  fault attrs to adapters even on the latency path.

**Explicitly out of scope (Phase 2 / separate issues):**

- Same-process integration (`server: ServerFaultHandle` direct passing,
  `reseed()` / `subscribe()` methods).
- Per-action correlation in the report (trace-id-indexed dict per action;
  Phase 1 surfaces a flat list and lets consumers join post-hoc).
- Automatic seed propagation between processes (Phase 1 documents the
  env-var convention; full automation can land later).

## Architecture

### Correlation primitive: `trace_id`

Layer correlation rides on the W3C `traceparent` header that
chaosbringer's Playwright route layer already injects on every request
(PR #72). server-faults extracts the trace-id segment from incoming
`traceparent` and stamps it onto every fault event. chaos parses the
trace-id back from response headers, so the same id flows through both
layers without a parallel id system.

This also means OTel exporters wired to either side automatically get a
`fault.trace_id` attribute that joins to spans the rest of the system
already emits.

### Event channel: response headers

server-faults mirrors its `FaultAttrs` schema onto kebab-case response
headers under a configurable prefix (default `x-chaos-fault`):

```
x-chaos-fault-kind: 5xx
x-chaos-fault-path: /api/todos
x-chaos-fault-method: GET
x-chaos-fault-target-status: 503
x-chaos-fault-trace-id: 0a1b2c3d4e5f60718293a4b5c6d7e8f9
```

For latency faults, the server returns its real (200/whatever) response
after sleeping; the headers ride on that real response. chaosbringer's
`page.on('response', …)` fires for both cases identically, so a single
hook handles both fault kinds.

### Why this shape

- **Headers, not a sidechannel control plane.** The server-faults
  process needs no extra endpoints, no IPC, no shared filesystem. The
  fault metadata is already attached to the response that triggered it.
- **Individual headers, not a JSON blob.** The attrs values are scalars;
  individual headers map 1:1 to the `fault.*` schema and parse with a
  single `headers.get(...)` per key. JSON-in-a-header would add a parse
  step and an error path with no benefit.
- **trace-id as the join key, not chaos-internal request ids.** PR #72
  already injects traceparent. Inventing a parallel `x-chaos-req-id`
  duplicates what's there and fragments the OTel story.

## Component changes

### `@mizchi/server-faults`

#### `FaultAttrs` gains `fault.trace_id`

```ts
export interface FaultAttrs {
  "fault.kind": FaultKind;
  "fault.path": string;
  "fault.method": string;
  "fault.target_status"?: number;
  "fault.latency_ms"?: number;
  "fault.trace_id"?: string;  // NEW
}
```

Extracted from the incoming request's `traceparent` header per W3C
Trace Context (segment 2 of `00-{trace-id}-{span-id}-{flags}`,
32 lowercase hex). Absent if the request has no traceparent or the
header is malformed.

#### `metadataHeader` option

```ts
export interface ServerFaultConfig {
  // … existing fields …
  /**
   * When set, fault attributes are mirrored to response headers so an
   * out-of-process consumer (e.g. chaosbringer's `chaos()` crawler) can
   * observe server-side faults without sharing memory with the server.
   * `true` uses the default prefix `x-chaos-fault`.
   */
  metadataHeader?: boolean | { prefix?: string };
}
```

Header naming rule: `{prefix}-{key}` where `key` is the attrs key after
stripping `fault.` and replacing `_` with `-`. So
`fault.target_status` → `x-chaos-fault-target-status`.

#### Breaking: `maybeInject` returns a verdict

```ts
export type FaultVerdict =
  | { kind: "synthetic"; response: Response; attrs: FaultAttrs }
  | { kind: "annotate"; attrs: FaultAttrs }
  | null;

export interface ServerFaultHandle {
  maybeInject: (req: Request) => Promise<FaultVerdict>;
}
```

- `synthetic` — server-faults already produced a `Response` (5xx case).
  Adapter returns it as-is; if `metadataHeader` is on, the response was
  built with the headers already attached.
- `annotate` — the latency raffle won. server-faults already slept, but
  the real handler must run; the adapter is responsible for setting the
  headers on the resulting response after `next()` returns. `attrs`
  carries the data the adapter writes.
- `null` — no fault, no instrumentation.

The four bundled adapters (`hono` / `express` / `fastify` / `koa`) are
updated to handle the three-way verdict. The 4 adapter files become the
canonical reference for how a custom adapter wires the `annotate` case.

### `chaosbringer`

#### `ChaosRunOptions.server`

```ts
export interface ChaosRemoteServer {
  mode: "remote";
  /** Header prefix to look for. Default `"x-chaos-fault"`. */
  responseHeaderPrefix?: string;
}

export interface ChaosRunOptions extends CrawlerOptions {
  // … existing fields …
  server?: ChaosRemoteServer;
}
```

Other shapes (e.g. direct handle for same-process integration) are
reserved for Phase 2 and rejected at runtime in Phase 1.

#### Response-header listener

`chaos()` (or the underlying `ChaosCrawler`) attaches
`page.on('response', resp => ...)` for every page it drives. When the
response carries `{prefix}-kind`, all matching headers are read and
parsed back into a `FaultAttrs` shape.

The parser tolerates missing optional headers (`target-status` for
latency faults, `latency-ms` for 5xx faults, `trace-id` for requests
without a traceparent) and rejects responses where `kind` is not a
known `FaultKind`.

#### `CrawlReport.serverFaults`

```ts
export interface ServerFaultEvent {
  traceId?: string;
  attrs: FaultAttrs;
  /** Wall-clock ms when chaos observed the response. */
  observedAt: number;
  /** URL of the page that triggered the request. */
  pageUrl: string;
}

export interface CrawlReport {
  // … existing fields …
  serverFaults?: ServerFaultEvent[];
}
```

Phase 1 keeps this as a flat list. Per-action joining (a dict keyed by
trace-id, surfaced inside `ActionResult`) is intentionally deferred so
we can ship the channel before designing how the report tree should
look. Consumers wanting per-action correlation in Phase 1 join by
trace-id manually.

## Data flow

```
Browser (Playwright)              Server process
  |                                  |
  |-- request, traceparent injected->|
  |                                  |-- server-faults rolls dice
  |                                  |     [synthetic 5xx]:
  |                                  |       response.headers +=
  |                                  |         x-chaos-fault-*
  |                                  |     [latency]:
  |                                  |       sleep, then handler runs,
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

## otel-chaos-lab adoption (separate PR)

After this lands, `otel-chaos-lab` adopts the new wiring in a follow-up:

1. Worker `serverFaults({ ..., metadataHeader: true })`.
2. `chaos/run.ts` adds `server: { mode: "remote" }` to its `chaos(...)`
   call.
3. Operations doc in `docs/notes/` records the env-var convention for
   matching seeds across processes (e.g. `CHAOS_SEED=42` exported once
   in `justfile`, consumed by both the worker and `chaos/run.ts`).
4. Verify the round trip: induced 5xx and latency events both show up
   in `report.serverFaults` with matching `trace_id` against the chaos
   action that produced the request.

## Testing strategy

### server-faults

- `metadataHeader` unit tests: 5xx case includes all expected headers;
  latency case carries headers via the `annotate` verdict; `prefix`
  override works; absent option means no headers.
- `fault.trace_id` extraction: valid traceparent yields the 32-hex
  segment; malformed / absent traceparent yields no `trace_id` key.
- Verdict migration: existing tests that asserted `Response | null`
  switch to verdict-shaped expectations. Each fault kind is exercised
  through every adapter (`hono` / `express` / `fastify` / `koa`).

### chaosbringer

- `page.on('response')` parser unit tests with synthetic Playwright
  responses: known headers parse correctly; unknown `kind` is rejected;
  missing optional headers don't error.
- An end-to-end fixture test: a Hono app wired with server-faults
  + `metadataHeader`, served via a real port (existing chaosbringer
  fixture pattern), driven by `chaos({ server: { mode: "remote" } })`.
  Assertion: `report.serverFaults` non-empty with the expected
  `kind` mix and trace-ids that intersect the page's request set.

### otel-chaos-lab

Separate follow-up PR. Real `wrangler dev` + `pnpm chaos`, asserts the
round-trip and lands the adoption.

## Risks and mitigations

- **Breaking `maybeInject`**. server-faults is on 0.x and externally
  has only the in-tree adapters as consumers. The blast radius is
  the four adapter files we own. No downstream releases yet pin the
  pre-verdict shape. (`otel-chaos-lab` uses `serverFaults` via the
  hono adapter; it's covered by the adapter migration.)
- **Header name collision**. The `x-chaos-fault-*` namespace is
  unique enough that production traffic should never carry it.
  `responseHeaderPrefix` is configurable for environments that
  enforce header allow-lists.
- **`page.on('response')` overhead**. Every response on every page
  hits the parser. The parser short-circuits on the absence of
  `{prefix}-kind`, so the cost is one `headers.get()` per response.
- **Latency-fault headers leaking real response state**. The adapter
  appends headers; it doesn't read the response body. Consumers that
  `Object.freeze` their response headers will fail loudly — documented
  in adapter source comments.

## Sequencing

1. **server-faults**: `fault.trace_id`, verdict refactor, adapters
   updated, `metadataHeader` plumbed (one PR; breaking, bumps minor).
2. **chaosbringer**: `server` option, `page.on('response')` listener,
   `CrawlReport.serverFaults`, fixture test (one PR).
3. **otel-chaos-lab**: adoption + verification PR.

Step 2 depends on step 1's released package. Step 3 depends on step 2.
