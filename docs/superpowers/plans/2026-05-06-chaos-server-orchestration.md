# Chaos × server-faults orchestration (C2 Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `@mizchi/server-faults` events into a chaosbringer `chaos()` run via response headers and trace_id, so a single chaos run produces one report covering both layers.

**Architecture:** server-faults extracts `fault.trace_id` from incoming `traceparent` and mirrors `FaultAttrs` onto kebab-case response headers (`x-chaos-fault-*`). chaosbringer attaches a `page.on('response', ...)` listener, parses those headers, and surfaces events via `CrawlReport.serverFaults`. `maybeInject` is refactored to a verdict shape so the latency path can also annotate the real response.

**Tech Stack:** TypeScript, vitest, Playwright, Web Standard `Request`/`Response`, W3C Trace Context.

**Spec:** [`docs/superpowers/specs/2026-05-06-chaos-server-orchestration-design.md`](../specs/2026-05-06-chaos-server-orchestration-design.md)

**Repository root for paths:** `~/ghq/github.com/mizchi/chaosbringer/` (all paths below are relative to this).

**Sequencing:**
- PR 1 (Tasks 1–9): server-faults breaking changes + metadataHeader.
- PR 2 (Tasks 10–14): chaosbringer integration. Depends on PR 1 being merged + a local link / version bump.

---

## PR 1 — server-faults: trace_id, verdict refactor, metadataHeader

### Task 1: Add `extractTraceId` helper + `fault.trace_id` to `FaultAttrs`

**Files:**
- Modify: `packages/server-faults/src/server-faults.ts`
- Modify: `packages/server-faults/src/server-faults.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/server-faults/src/server-faults.test.ts`:

```ts
describe("fault.trace_id", () => {
  it("populates fault.trace_id from a valid traceparent header", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      status5xxRate: 1,
      observer: { onFault },
    });
    const r = new Request("https://test.local/api/x", {
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    });
    await fault.maybeInject(r);
    expect(onFault).toHaveBeenCalledWith(
      "5xx",
      expect.objectContaining({ "fault.trace_id": "0af7651916cd43dd8448eb211c80319c" }),
    );
  });

  it("omits fault.trace_id when traceparent is absent", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({ status5xxRate: 1, observer: { onFault } });
    await fault.maybeInject(new Request("https://test.local/api/x"));
    const attrs = onFault.mock.calls[0][1] as Record<string, unknown>;
    expect("fault.trace_id" in attrs).toBe(false);
  });

  it("omits fault.trace_id when traceparent is malformed", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({ status5xxRate: 1, observer: { onFault } });
    const r = new Request("https://test.local/api/x", {
      headers: { traceparent: "garbage" },
    });
    await fault.maybeInject(r);
    const attrs = onFault.mock.calls[0][1] as Record<string, unknown>;
    expect("fault.trace_id" in attrs).toBe(false);
  });

  it("populates fault.trace_id on latency events too", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      latencyRate: 1,
      latencyMs: 1,
      observer: { onFault },
    });
    const r = new Request("https://test.local/api/x", {
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    });
    await fault.maybeInject(r);
    expect(onFault).toHaveBeenCalledWith(
      "latency",
      expect.objectContaining({ "fault.trace_id": "0af7651916cd43dd8448eb211c80319c" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/ghq/github.com/mizchi/chaosbringer
pnpm --filter @mizchi/server-faults test -- server-faults.test.ts -t "fault.trace_id"
```

Expected: 4 failing tests (assertions on `fault.trace_id`).

- [ ] **Step 3: Implement extractor + wire into both observer call sites**

In `packages/server-faults/src/server-faults.ts`, after the `FaultAttrs` interface, add the optional field:

```ts
export interface FaultAttrs {
  "fault.kind": FaultKind;
  "fault.path": string;
  "fault.method": string;
  "fault.target_status"?: number;
  "fault.latency_ms"?: number;
  /** Trace-id from incoming traceparent (W3C Trace Context). 32 lowercase hex. */
  "fault.trace_id"?: string;
}
```

Add the helper near `compileStatelessPattern`:

```ts
const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

function extractTraceId(req: Request): string | undefined {
  const tp = req.headers.get("traceparent");
  if (!tp) return undefined;
  const m = TRACEPARENT_RE.exec(tp);
  return m ? m[1] : undefined;
}
```

In `serverFaults()`, replace each `observer.onFault?.(...)` call with one that conditionally sets `"fault.trace_id"`:

```ts
const traceId = extractTraceId(req);

// 5xx branch:
const attrs5xx: FaultAttrs = {
  "fault.kind": "5xx",
  "fault.path": url.pathname,
  "fault.method": method,
  "fault.target_status": status,
};
if (traceId !== undefined) attrs5xx["fault.trace_id"] = traceId;
cfg.observer?.onFault?.("5xx", attrs5xx);

// latency branch:
const attrsLat: FaultAttrs = {
  "fault.kind": "latency",
  "fault.path": url.pathname,
  "fault.method": method,
  "fault.latency_ms": ms,
};
if (traceId !== undefined) attrsLat["fault.trace_id"] = traceId;
cfg.observer?.onFault?.("latency", attrsLat);
```

- [ ] **Step 4: Run tests to verify**

```bash
pnpm --filter @mizchi/server-faults test
```

Expected: full suite green, including the 4 new trace_id tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/server-faults.ts packages/server-faults/src/server-faults.test.ts
git commit -m "feat(server-faults): add fault.trace_id extracted from W3C traceparent"
```

---

### Task 2: Refactor `maybeInject` return type to `FaultVerdict`

**Files:**
- Modify: `packages/server-faults/src/server-faults.ts`
- Modify: `packages/server-faults/src/server-faults.test.ts`

This is a breaking change. We update `serverFaults()` and its tests in this task; adapters break and are repaired in Tasks 4–7 — they are intentionally left broken between commits within this PR (the four `pnpm --filter ... test` runs in tasks 4–7 will fail until each adapter is updated).

- [ ] **Step 1: Update existing test assertions to verdict shape**

Edit each existing assertion in `packages/server-faults/src/server-faults.test.ts` that currently checks `Response | null` to check the new verdict. Search and replace patterns:

| Old assertion | New assertion |
| --- | --- |
| `expect(await fault.maybeInject(req("/x"))).toBeNull();` | `expect(await fault.maybeInject(req("/x"))).toBeNull();` *(no change)* |
| `const response = await fault.maybeInject(req("/x")); expect(response).not.toBeNull(); expect(response!.status).toBe(503);` | `const v = await fault.maybeInject(req("/x")); expect(v?.kind).toBe("synthetic"); expect((v as { kind: "synthetic"; response: Response }).response.status).toBe(503);` |
| `expect(await fault.maybeInject(...)).not.toBeNull();` (used as a "fault occurred" probe) | `const v = await fault.maybeInject(...); expect(v).not.toBeNull();` *(stays — both `synthetic` and `annotate` are truthy non-null)* |

For the two latency-fakeTimer tests (`delays the request by latencyMs (number)` / `returns null after latency`), update the resolved-value assertion: the latency verdict is now `{ kind: "annotate", attrs: ... }`, not `null`. Replace `expect(result).toBeNull();` with `expect(result?.kind).toBe("annotate");` and `expect(await promise).toBeNull();` with `expect((await promise)?.kind).toBe("annotate");`.

- [ ] **Step 2: Run tests, observe what now needs fixing in source**

```bash
pnpm --filter @mizchi/server-faults test -- server-faults.test.ts
```

Expected: every test that exercises a fault path fails with a type or runtime mismatch — verdict properties are missing.

- [ ] **Step 3: Implement the verdict in `serverFaults()`**

In `packages/server-faults/src/server-faults.ts`:

Add the verdict types (just below `FaultAttrs`):

```ts
export type FaultVerdict =
  | { kind: "synthetic"; response: Response; attrs: FaultAttrs }
  | { kind: "annotate"; attrs: FaultAttrs }
  | null;
```

Change `ServerFaultHandle`:

```ts
export interface ServerFaultHandle {
  maybeInject: (req: Request) => Promise<FaultVerdict>;
}
```

Rewrite the `maybeInject` body so the 5xx branch returns `{ kind: "synthetic", response, attrs: attrs5xx }` and the latency branch returns `{ kind: "annotate", attrs: attrsLat }` after `await sleep(ms)`. The early-exit branches (bypass header, exempt path, no pattern match, no raffle won) keep returning `null`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- server-faults.test.ts
```

Expected: full file green.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/server-faults.ts packages/server-faults/src/server-faults.test.ts
git commit -m "feat(server-faults)!: maybeInject returns FaultVerdict (synthetic/annotate/null)"
```

---

### Task 3: Add `metadataHeader` option

**Files:**
- Modify: `packages/server-faults/src/server-faults.ts`
- Modify: `packages/server-faults/src/server-faults.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/server-faults/src/server-faults.test.ts`:

```ts
describe("metadataHeader", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

  it("attaches all 5xx attrs as kebab-case headers on synthetic responses", async () => {
    const fault = serverFaults({ status5xxRate: 1, metadataHeader: true });
    const r = new Request("https://test.local/api/x", { headers: { traceparent: TP } });
    const v = await fault.maybeInject(r);
    expect(v?.kind).toBe("synthetic");
    const resp = (v as { response: Response }).response;
    expect(resp.headers.get("x-chaos-fault-kind")).toBe("5xx");
    expect(resp.headers.get("x-chaos-fault-path")).toBe("/api/x");
    expect(resp.headers.get("x-chaos-fault-method")).toBe("GET");
    expect(resp.headers.get("x-chaos-fault-target-status")).toBe("503");
    expect(resp.headers.get("x-chaos-fault-trace-id")).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(resp.headers.get("x-chaos-fault-latency-ms")).toBeNull();
  });

  it("does not attach headers when metadataHeader is unset", async () => {
    const fault = serverFaults({ status5xxRate: 1 });
    const v = await fault.maybeInject(new Request("https://test.local/api/x"));
    const resp = (v as { kind: "synthetic"; response: Response }).response;
    expect(resp.headers.get("x-chaos-fault-kind")).toBeNull();
  });

  it("honours custom prefix", async () => {
    const fault = serverFaults({ status5xxRate: 1, metadataHeader: { prefix: "x-my-fault" } });
    const v = await fault.maybeInject(new Request("https://test.local/api/x"));
    const resp = (v as { kind: "synthetic"; response: Response }).response;
    expect(resp.headers.get("x-my-fault-kind")).toBe("5xx");
    expect(resp.headers.get("x-chaos-fault-kind")).toBeNull();
  });

  it("returns annotate verdict carrying full attrs for latency (adapter must apply headers)", async () => {
    const fault = serverFaults({ latencyRate: 1, latencyMs: 1, metadataHeader: true });
    const r = new Request("https://test.local/api/x", { headers: { traceparent: TP } });
    const v = await fault.maybeInject(r);
    expect(v?.kind).toBe("annotate");
    const attrs = (v as { kind: "annotate"; attrs: FaultAttrs }).attrs;
    expect(attrs["fault.kind"]).toBe("latency");
    expect(attrs["fault.latency_ms"]).toBe(1);
    expect(attrs["fault.trace_id"]).toBe("0af7651916cd43dd8448eb211c80319c");
  });
});
```

(Add `import type { FaultAttrs } from "./server-faults.js";` if not already imported.)

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter @mizchi/server-faults test -- server-faults.test.ts -t metadataHeader
```

Expected: all four tests fail (`x-chaos-fault-kind` is null, `metadataHeader` config field doesn't exist).

- [ ] **Step 3: Implement option + helpers**

In `packages/server-faults/src/server-faults.ts`:

1. Extend `ServerFaultConfig`:

```ts
export interface ServerFaultConfig {
  // … existing fields …
  /**
   * When set, server-faults mirrors `FaultAttrs` onto response headers so
   * out-of-process consumers (e.g. chaosbringer's `chaos()` crawler) can
   * observe server-side faults without sharing memory with the server.
   *
   * Header naming: `{prefix}-{key}`, where `key` is the attrs key with
   * `fault.` stripped and `_` replaced by `-` (e.g. `fault.target_status`
   * → `{prefix}-target-status`). `true` uses the default prefix
   * `"x-chaos-fault"`.
   */
  metadataHeader?: boolean | { prefix?: string };
}
```

2. Add a helper to materialise the header set:

```ts
const DEFAULT_METADATA_PREFIX = "x-chaos-fault";

function attrsToHeaderEntries(attrs: FaultAttrs, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    // Strip "fault." prefix; underscore → kebab.
    const tail = k.replace(/^fault\./, "").replace(/_/g, "-");
    out.push([`${prefix}-${tail}`, String(v)]);
  }
  return out;
}

function resolveMetadataPrefix(opt: ServerFaultConfig["metadataHeader"]): string | null {
  if (!opt) return null;
  if (opt === true) return DEFAULT_METADATA_PREFIX;
  return opt.prefix ?? DEFAULT_METADATA_PREFIX;
}
```

3. In `serverFaults()`, capture the prefix once: `const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);`. In the 5xx branch, after building `attrs5xx`, build the synthetic response's `Headers`:

```ts
const headers = new Headers();
if (metadataPrefix) {
  for (const [name, value] of attrsToHeaderEntries(attrs5xx, metadataPrefix)) {
    headers.set(name, value);
  }
}
const response = Response.json(
  { error: "chaos: synthetic 5xx", path: url.pathname, status },
  { status, headers },
);
return { kind: "synthetic", response, attrs: attrs5xx };
```

The latency branch returns `{ kind: "annotate", attrs: attrsLat }`. The `metadataPrefix` value is not consumed there — adapters look up `cfg` themselves, see Tasks 4–7. (Adapters import `attrsToHeaderEntries` and `resolveMetadataPrefix` indirectly: we re-export them privately from server-faults.ts so adapters can reuse the same encoding without redefining the rule. Add `export` to both helpers.)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- server-faults.test.ts
```

Expected: full file green.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/server-faults.ts packages/server-faults/src/server-faults.test.ts
git commit -m "feat(server-faults): add metadataHeader option (mirror fault attrs to response headers)"
```

---

### Task 4: Update Hono adapter for verdict + annotate path

**Files:**
- Modify: `packages/server-faults/src/adapters/hono.ts`
- Modify: `packages/server-faults/src/adapters/adapters.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe("honoMiddleware", …)` block in `packages/server-faults/src/adapters/adapters.test.ts`:

```ts
it("returns synthetic 5xx response unchanged (headers already attached)", async () => {
  const mw = honoMiddleware({ status5xxRate: 1, metadataHeader: true });
  const next = vi.fn();
  const c = { req: { raw: new Request("https://test.local/api/x") } };
  const out = await mw(c, next);
  expect((out as Response).status).toBe(503);
  expect((out as Response).headers.get("x-chaos-fault-kind")).toBe("5xx");
});

it("calls next() and stamps headers on c.res for latency annotate verdict", async () => {
  const mw = honoMiddleware({ latencyRate: 1, latencyMs: 0, metadataHeader: true });
  const headers = new Headers();
  const c = {
    req: { raw: new Request("https://test.local/api/x") },
    res: { headers },
  };
  const next = vi.fn(async () => undefined);
  await mw(c as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(headers.get("x-chaos-fault-kind")).toBe("latency");
  expect(headers.get("x-chaos-fault-latency-ms")).toBe("0");
});

it("does not stamp latency headers when metadataHeader is off", async () => {
  const mw = honoMiddleware({ latencyRate: 1, latencyMs: 0 });
  const headers = new Headers();
  const c = {
    req: { raw: new Request("https://test.local/api/x") },
    res: { headers },
  };
  const next = vi.fn(async () => undefined);
  await mw(c as never, next);
  expect(headers.get("x-chaos-fault-kind")).toBeNull();
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t honoMiddleware
```

Expected: existing passing tests now fail (verdict shape changed) plus the new 3 fail.

- [ ] **Step 3: Update `hono.ts`**

Replace the contents of `packages/server-faults/src/adapters/hono.ts` with:

```ts
/**
 * Hono adapter for @mizchi/server-faults.
 *
 * `c.req.raw` is a Web Standard Request, so the adapter is mostly a thin
 * wrapper around `serverFaults({...}).maybeInject(req)`. The latency
 * (annotate) path requires running the real handler first and then
 * stamping the metadata headers onto `c.res.headers` afterwards.
 */

import {
  serverFaults,
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  type ServerFaultConfig,
} from "../server-faults.js";

interface HonoLikeContext {
  req: { raw: Request };
  res?: { headers: Headers };
}
interface HonoLikeNext {
  (): Promise<unknown>;
}
type HonoLikeMiddleware = (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | undefined | void>;

export function honoMiddleware(cfg: ServerFaultConfig): HonoLikeMiddleware {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (c, next) => {
    const verdict = await fault.maybeInject(c.req.raw);
    if (!verdict) return next().then(() => undefined);
    if (verdict.kind === "synthetic") return verdict.response;
    // annotate: real handler runs, then stamp headers if requested.
    await next();
    if (metadataPrefix && c.res?.headers) {
      for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
        c.res.headers.set(name, value);
      }
    }
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t honoMiddleware
```

Expected: 5 hono tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/adapters/hono.ts packages/server-faults/src/adapters/adapters.test.ts
git commit -m "feat(server-faults/hono): support FaultVerdict + metadataHeader stamping"
```

---

### Task 5: Update Express adapter

**Files:**
- Modify: `packages/server-faults/src/adapters/express.ts`
- Modify: `packages/server-faults/src/adapters/adapters.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the `describe("expressMiddleware", …)` block:

```ts
it("stamps metadata headers on res for the latency annotate verdict", async () => {
  const mw = expressMiddleware({ latencyRate: 1, latencyMs: 0, metadataHeader: true });
  const next = vi.fn();
  const req = { method: "GET", originalUrl: "/api/x", headers: { host: "test.local" } };
  const res = makeRes();
  await mw(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.headers["x-chaos-fault-kind"]).toBe("latency");
  expect(res.headers["x-chaos-fault-path"]).toBe("/api/x");
});

it("does not stamp latency headers when metadataHeader is off", async () => {
  const mw = expressMiddleware({ latencyRate: 1, latencyMs: 0 });
  const next = vi.fn();
  const req = { method: "GET", originalUrl: "/api/x", headers: {} };
  const res = makeRes();
  await mw(req, res, next);
  expect(res.headers["x-chaos-fault-kind"]).toBeUndefined();
});

it("attaches metadata headers to synthetic 5xx response", async () => {
  const mw = expressMiddleware({ status5xxRate: 1, metadataHeader: true });
  const next = vi.fn();
  const req = { method: "GET", originalUrl: "/api/x", headers: { host: "test.local" } };
  const res = makeRes();
  await mw(req, res, next);
  expect(res.statusCode).toBe(503);
  expect(res.headers["x-chaos-fault-kind"]).toBe("5xx");
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t expressMiddleware
```

Expected: pre-existing tests fail (verdict shape changed) plus new tests fail.

- [ ] **Step 3: Update `express.ts`**

Replace the body of `expressMiddleware()`:

```ts
export function expressMiddleware(
  cfg: ServerFaultConfig,
): (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressLikeNext) => Promise<void> {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (req, res, next) => {
    try {
      const verdict = await fault.maybeInject(toWebRequest(req));
      if (!verdict) return next();
      if (verdict.kind === "synthetic") {
        res.status(verdict.response.status);
        verdict.response.headers.forEach((value, key) => {
          if (key.toLowerCase() === "content-type") return;
          res.setHeader(key, value);
        });
        res.json(await verdict.response.json());
        return;
      }
      // annotate: stamp headers, then hand off to the real handler.
      if (metadataPrefix) {
        for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
          res.setHeader(name, value);
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

Update imports:

```ts
import {
  serverFaults,
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  type ServerFaultConfig,
} from "../server-faults.js";
```

(Express writes headers before the response body is flushed. Stamping the metadata headers *before* calling `next()` is safe — Express buffers them on the response object until the handler responds, so when the real handler eventually calls `res.send(...)` the metadata headers ride along.)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t expressMiddleware
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/adapters/express.ts packages/server-faults/src/adapters/adapters.test.ts
git commit -m "feat(server-faults/express): support FaultVerdict + metadataHeader stamping"
```

---

### Task 6: Update Fastify adapter

**Files:**
- Modify: `packages/server-faults/src/adapters/fastify.ts`
- Modify: `packages/server-faults/src/adapters/adapters.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `describe("fastifyPlugin", …)`:

```ts
it("stamps metadata headers via reply.header() for latency annotate verdict", async () => {
  const plugin = fastifyPlugin({ latencyRate: 1, latencyMs: 0, metadataHeader: true });
  let registered: ((req: unknown, reply: unknown) => Promise<void>) | null = null;
  const fastify = {
    addHook(_: "onRequest", h: (req: unknown, reply: unknown) => Promise<void>) {
      registered = h;
    },
  };
  await plugin(fastify);
  const req = { method: "GET", url: "/api/x", headers: { host: "test.local" } };
  const reply = {
    _headers: {} as Record<string, string>,
    code() { return this; },
    header(k: string, v: string) { this._headers[k] = v; return this; },
    send() { return undefined; },
  };
  await registered!(req, reply);
  expect(reply._headers["x-chaos-fault-kind"]).toBe("latency");
});

it("attaches metadata headers to synthetic 5xx reply", async () => {
  const plugin = fastifyPlugin({ status5xxRate: 1, metadataHeader: true });
  let registered: ((req: unknown, reply: unknown) => Promise<void>) | null = null;
  const fastify = {
    addHook(_: "onRequest", h: (req: unknown, reply: unknown) => Promise<void>) {
      registered = h;
    },
  };
  await plugin(fastify);
  const req = { method: "GET", url: "/api/x", headers: { host: "test.local" } };
  const reply = {
    _code: 0,
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    code(c: number) { this._code = c; return this; },
    header(k: string, v: string) { this._headers[k] = v; return this; },
    send(body: unknown) { this._body = body; return body; },
  };
  await registered!(req, reply);
  expect(reply._code).toBe(503);
  expect(reply._headers["x-chaos-fault-kind"]).toBe("5xx");
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t fastifyPlugin
```

Expected: pre-existing tests fail + new tests fail.

- [ ] **Step 3: Update `fastify.ts`**

Replace `fastifyPlugin()`:

```ts
export function fastifyPlugin(cfg: ServerFaultConfig) {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async function plugin(fastify: FastifyLikeInstance) {
    fastify.addHook("onRequest", async (req, reply) => {
      const verdict = await fault.maybeInject(toWebRequest(req));
      if (!verdict) return;
      if (verdict.kind === "synthetic") {
        reply.code(verdict.response.status);
        verdict.response.headers.forEach((value, key) => {
          reply.header(key, value);
        });
        await reply.send(await verdict.response.json());
        return;
      }
      // annotate: stamp headers; the real route runs after the onRequest hook returns.
      if (metadataPrefix) {
        for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
          reply.header(name, value);
        }
      }
    });
  };
}
```

Update imports the same way as Tasks 4–5.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t fastifyPlugin
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/adapters/fastify.ts packages/server-faults/src/adapters/adapters.test.ts
git commit -m "feat(server-faults/fastify): support FaultVerdict + metadataHeader stamping"
```

---

### Task 7: Update Koa adapter

**Files:**
- Modify: `packages/server-faults/src/adapters/koa.ts`
- Modify: `packages/server-faults/src/adapters/adapters.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `describe("koaMiddleware", …)`:

```ts
it("stamps metadata headers via ctx.set() for latency annotate verdict", async () => {
  const mw = koaMiddleware({ latencyRate: 1, latencyMs: 0, metadataHeader: true });
  const next = vi.fn(async () => undefined);
  const ctx = {
    req: { method: "GET", url: "/api/x", headers: { host: "test.local" } },
    status: 0,
    body: undefined as unknown,
    _headers: {} as Record<string, string>,
    set(k: string, v: string) { this._headers[k] = v; },
  };
  await mw(ctx, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(ctx._headers["x-chaos-fault-kind"]).toBe("latency");
});

it("attaches metadata headers to synthetic 5xx ctx", async () => {
  const mw = koaMiddleware({ status5xxRate: 1, metadataHeader: true });
  const next = vi.fn();
  const ctx = {
    req: { method: "GET", url: "/api/x", headers: { host: "test.local" } },
    status: 0,
    body: undefined as unknown,
    _headers: {} as Record<string, string>,
    set(k: string, v: string) { this._headers[k] = v; },
  };
  await mw(ctx, next);
  expect(ctx.status).toBe(503);
  expect(ctx._headers["x-chaos-fault-kind"]).toBe("5xx");
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t koaMiddleware
```

Expected: pre-existing fail + new fail.

- [ ] **Step 3: Update `koa.ts`**

Replace `koaMiddleware()`:

```ts
export function koaMiddleware(
  cfg: ServerFaultConfig,
): (ctx: KoaLikeContext, next: KoaLikeNext) => Promise<void> {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (ctx, next) => {
    const verdict = await fault.maybeInject(toWebRequest(ctx.req));
    if (!verdict) {
      await next();
      return;
    }
    if (verdict.kind === "synthetic") {
      ctx.status = verdict.response.status;
      verdict.response.headers.forEach((value, key) => {
        ctx.set(key, value);
      });
      ctx.body = await verdict.response.json();
      return;
    }
    // annotate: stamp headers, then continue to the real handler.
    if (metadataPrefix) {
      for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
        ctx.set(name, value);
      }
    }
    await next();
  };
}
```

Update imports.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @mizchi/server-faults test -- adapters.test.ts -t koaMiddleware
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/server-faults/src/adapters/koa.ts packages/server-faults/src/adapters/adapters.test.ts
git commit -m "feat(server-faults/koa): support FaultVerdict + metadataHeader stamping"
```

---

### Task 8: Run full server-faults suite + build

**Files:** none modified.

- [ ] **Step 1: Full test run**

```bash
pnpm --filter @mizchi/server-faults test
```

Expected: all green.

- [ ] **Step 2: Type check + build**

```bash
pnpm --filter @mizchi/server-faults build
```

Expected: tsc reports zero errors and `dist/` is regenerated.

- [ ] **Step 3: Commit any package-json changes if `engines` / exports needed updating**

If no changes, skip. Otherwise:

```bash
git add packages/server-faults/package.json
git commit -m "chore(server-faults): refresh build artefacts"
```

---

### Task 9: Open PR 1

**Files:** none modified.

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin feat/server-faults-metadata-header
gh pr create --title "feat(server-faults)!: trace_id, FaultVerdict, metadataHeader" --body "$(cat <<'EOF'
## Summary
- `FaultAttrs` gains `fault.trace_id` extracted from incoming W3C `traceparent`
- `maybeInject` now returns `FaultVerdict` (`synthetic` | `annotate` | `null`); the latency path returns `annotate` so adapters can stamp metadata headers on the real response
- `metadataHeader` option mirrors fault attrs onto kebab-case response headers (`x-chaos-fault-*` by default)
- All four adapters (hono / express / fastify / koa) updated for the new verdict + header stamping

Spec: `docs/superpowers/specs/2026-05-06-chaos-server-orchestration-design.md`

Refs: closes part of #56 (server-faults side).

## Test plan
- [x] `pnpm --filter @mizchi/server-faults test` passes locally
- [x] `pnpm --filter @mizchi/server-faults build` succeeds
- [ ] Will be exercised end-to-end by the chaosbringer integration in PR 2 + the otel-chaos-lab adoption PR
EOF
)"
```

(`origin` = `git@github.com:mizchi/chaosbringer`. Branch must be created off main: `git checkout -b feat/server-faults-metadata-header` before Task 1.)

---

## PR 2 — chaosbringer: ingest server-side faults via response headers

**Pre-requisite:** PR 1 must be merged. Create branch: `git checkout main && git pull && git checkout -b feat/chaos-server-mode-remote`. The chaosbringer monorepo's workspace symlink keeps `@mizchi/server-faults` pointed at the in-tree package, so PR 1's changes are immediately consumable.

### Task 10: Add response-header parser

**Files:**
- Create: `packages/chaosbringer/src/server-fault-events.ts`
- Create: `packages/chaosbringer/src/server-fault-events.test.ts`

This module is the unit responsible for translating raw response headers back into a `FaultAttrs`-shaped event. Pure function, no Playwright surface, easy to unit-test.

- [ ] **Step 1: Write the failing test**

Create `packages/chaosbringer/src/server-fault-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseServerFaultHeaders } from "./server-fault-events.js";

const make = (entries: Record<string, string>) => {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
};

describe("parseServerFaultHeaders", () => {
  it("returns null when the prefix marker is absent", () => {
    const h = make({ "content-type": "application/json" });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("parses a 5xx event with all headers present", () => {
    const h = make({
      "x-chaos-fault-kind": "5xx",
      "x-chaos-fault-path": "/api/todos",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-target-status": "503",
      "x-chaos-fault-trace-id": "0af7651916cd43dd8448eb211c80319c",
    });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toEqual({
      attrs: {
        "fault.kind": "5xx",
        "fault.path": "/api/todos",
        "fault.method": "GET",
        "fault.target_status": 503,
        "fault.trace_id": "0af7651916cd43dd8448eb211c80319c",
      },
      traceId: "0af7651916cd43dd8448eb211c80319c",
    });
  });

  it("parses a latency event without target-status", () => {
    const h = make({
      "x-chaos-fault-kind": "latency",
      "x-chaos-fault-path": "/api/x",
      "x-chaos-fault-method": "POST",
      "x-chaos-fault-latency-ms": "350",
    });
    const r = parseServerFaultHeaders(h, "x-chaos-fault");
    expect(r?.attrs).toEqual({
      "fault.kind": "latency",
      "fault.path": "/api/x",
      "fault.method": "POST",
      "fault.latency_ms": 350,
    });
    expect(r?.traceId).toBeUndefined();
  });

  it("returns null for unknown kind", () => {
    const h = make({
      "x-chaos-fault-kind": "abort",
      "x-chaos-fault-path": "/x",
      "x-chaos-fault-method": "GET",
    });
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("honours custom prefix", () => {
    const h = make({
      "x-my-fault-kind": "5xx",
      "x-my-fault-path": "/api",
      "x-my-fault-method": "GET",
      "x-my-fault-target-status": "500",
    });
    expect(parseServerFaultHeaders(h, "x-my-fault")?.attrs["fault.kind"]).toBe("5xx");
    expect(parseServerFaultHeaders(h, "x-chaos-fault")).toBeNull();
  });

  it("ignores numeric headers that fail to parse", () => {
    const h = make({
      "x-chaos-fault-kind": "latency",
      "x-chaos-fault-path": "/api",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-latency-ms": "not-a-number",
    });
    const r = parseServerFaultHeaders(h, "x-chaos-fault");
    // Latency event still parses; the bad number is dropped (no fault.latency_ms).
    expect(r?.attrs["fault.kind"]).toBe("latency");
    expect(r?.attrs["fault.latency_ms"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter chaosbringer test -- server-fault-events.test.ts
```

Expected: file not found / module not resolved.

- [ ] **Step 3: Implement the parser**

Create `packages/chaosbringer/src/server-fault-events.ts`:

```ts
/**
 * Parser for the `x-chaos-fault-*` response headers emitted by
 * `@mizchi/server-faults` when its `metadataHeader` option is set.
 * Pure function: no I/O, no Playwright surface — invoked from
 * `page.on('response', …)` once per response.
 */

const KNOWN_KINDS = new Set(["5xx", "latency"]);

export interface ServerFaultEventAttrs {
  "fault.kind": "5xx" | "latency";
  "fault.path": string;
  "fault.method": string;
  "fault.target_status"?: number;
  "fault.latency_ms"?: number;
  "fault.trace_id"?: string;
}

export interface ParsedServerFault {
  attrs: ServerFaultEventAttrs;
  traceId?: string;
}

export function parseServerFaultHeaders(
  headers: Headers,
  prefix: string,
): ParsedServerFault | null {
  const kind = headers.get(`${prefix}-kind`);
  if (!kind || !KNOWN_KINDS.has(kind)) return null;

  const path = headers.get(`${prefix}-path`);
  const method = headers.get(`${prefix}-method`);
  if (!path || !method) return null;

  const attrs: ServerFaultEventAttrs = {
    "fault.kind": kind as "5xx" | "latency",
    "fault.path": path,
    "fault.method": method,
  };

  const targetStatus = headers.get(`${prefix}-target-status`);
  if (targetStatus !== null) {
    const n = Number.parseInt(targetStatus, 10);
    if (Number.isFinite(n)) attrs["fault.target_status"] = n;
  }

  const latencyMs = headers.get(`${prefix}-latency-ms`);
  if (latencyMs !== null) {
    const n = Number.parseFloat(latencyMs);
    if (Number.isFinite(n)) attrs["fault.latency_ms"] = n;
  }

  const traceId = headers.get(`${prefix}-trace-id`) ?? undefined;
  if (traceId) attrs["fault.trace_id"] = traceId;

  return { attrs, traceId };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter chaosbringer test -- server-fault-events.test.ts
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/chaosbringer/src/server-fault-events.ts packages/chaosbringer/src/server-fault-events.test.ts
git commit -m "feat(chaosbringer): parse x-chaos-fault-* response headers into events"
```

---

### Task 11: Wire `ChaosRemoteServer` option through `ChaosRunOptions` and types

**Files:**
- Modify: `packages/chaosbringer/src/chaos.ts`
- Modify: `packages/chaosbringer/src/types.ts`
- Modify: `packages/chaosbringer/src/index.ts`

This task adds the public type surface and threads it down into the crawler's options bag. No behaviour change yet — Task 12 attaches the listener and Task 13 surfaces events on the report.

- [ ] **Step 1: Add types**

In `packages/chaosbringer/src/types.ts`, append at the bottom:

```ts
/**
 * Server-side fault ingestion mode. Phase 1 supports `"remote"`: the server
 * runs in a different process and emits `x-chaos-fault-*` response headers
 * via `@mizchi/server-faults`'s `metadataHeader` option. chaos() listens for
 * those headers and surfaces the events on `CrawlReport.serverFaults`.
 */
export interface ChaosRemoteServer {
  mode: "remote";
  /** Header prefix to look for. Default `"x-chaos-fault"`. */
  responseHeaderPrefix?: string;
}

export interface ServerFaultEvent {
  /** Trace-id from the response headers (W3C traceparent's trace-id segment). */
  traceId?: string;
  attrs: {
    "fault.kind": "5xx" | "latency";
    "fault.path": string;
    "fault.method": string;
    "fault.target_status"?: number;
    "fault.latency_ms"?: number;
    "fault.trace_id"?: string;
  };
  /** Wall-clock ms when chaos observed the response. */
  observedAt: number;
  /** URL of the page that triggered the request. */
  pageUrl: string;
}
```

In the same file, find the `CrawlReport` interface and add the optional field at the end of its body:

```ts
  /**
   * Server-side fault events ingested via response headers (present only
   * when `chaos({ server: { mode: "remote" } })` was set and the server
   * was emitting `x-chaos-fault-*` headers via `@mizchi/server-faults`).
   * Flat list across the whole run; consumers join by `traceId` for
   * per-action correlation.
   */
  serverFaults?: ServerFaultEvent[];
```

- [ ] **Step 2: Add to `ChaosRunOptions`**

In `packages/chaosbringer/src/chaos.ts`, import the new types and extend the interface:

```ts
import type {
  CrawlerEvents,
  CrawlerOptions,
  CrawlReport,
  ChaosRemoteServer,
} from "./types.js";
```

Inside `ChaosRunOptions`, after the `setup` field:

```ts
  /**
   * Surface server-side fault events into `report.serverFaults`. Phase 1:
   * `{ mode: "remote" }` reads `x-chaos-fault-*` response headers emitted
   * by `@mizchi/server-faults` running in the server process.
   */
  server?: ChaosRemoteServer;
```

In the destructuring of `chaos()`, pull `server` out:

```ts
const { strict, baseline, baselineStrict, setup, server, ...crawlerOptions } = options;
```

Pass it into the crawler options (we extend `CrawlerOptions` to carry it through):

```ts
const crawler = new ChaosCrawler({ ...crawlerOptions, server } as CrawlerOptions, events);
```

- [ ] **Step 3: Mirror onto `CrawlerOptions`**

In `packages/chaosbringer/src/types.ts`, locate `CrawlerOptions`. Add inside its body:

```ts
  /** @internal Set by `chaos({ server })`. */
  server?: ChaosRemoteServer;
```

- [ ] **Step 4: Re-export from index**

In `packages/chaosbringer/src/index.ts`, add to the type re-export block (where `TraceparentInjectionOptions` lives):

```ts
  ChaosRemoteServer,
  ServerFaultEvent,
```

(Both go in the existing `export type {` from `./types.js` block.)

- [ ] **Step 5: Type-check**

```bash
pnpm --filter chaosbringer build
```

Expected: tsc reports zero errors.

- [ ] **Step 6: Commit**

```bash
git add packages/chaosbringer/src/chaos.ts packages/chaosbringer/src/types.ts packages/chaosbringer/src/index.ts
git commit -m "feat(chaosbringer): add ChaosRemoteServer option type (no behaviour yet)"
```

---

### Task 12: Attach `page.on('response')` listener and collect events

**Files:**
- Modify: `packages/chaosbringer/src/crawler.ts`
- Create: `packages/chaosbringer/src/server-fault-collector.ts`
- Create: `packages/chaosbringer/src/server-fault-collector.test.ts`

The collector is its own module so we can unit-test it without spinning up a real Page. The crawler holds one collector per crawl and pushes its events into the final report.

- [ ] **Step 1: Write failing collector test**

Create `packages/chaosbringer/src/server-fault-collector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ServerFaultCollector } from "./server-fault-collector.js";

describe("ServerFaultCollector", () => {
  it("records 5xx events with pageUrl and observedAt", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    const headers = new Headers({
      "x-chaos-fault-kind": "5xx",
      "x-chaos-fault-path": "/api/todos",
      "x-chaos-fault-method": "GET",
      "x-chaos-fault-target-status": "503",
      "x-chaos-fault-trace-id": "0af7651916cd43dd8448eb211c80319c",
    });
    c.observe({ headers, pageUrl: "https://app/todos" });
    const events = c.drain();
    expect(events).toHaveLength(1);
    expect(events[0].pageUrl).toBe("https://app/todos");
    expect(events[0].traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(events[0].attrs["fault.kind"]).toBe("5xx");
    expect(typeof events[0].observedAt).toBe("number");
  });

  it("ignores responses without the prefix", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({ headers: new Headers({ "x-other": "1" }), pageUrl: "https://app" });
    expect(c.drain()).toHaveLength(0);
  });

  it("preserves event order across pages", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    const headers = (kind: string, path: string) =>
      new Headers({
        "x-chaos-fault-kind": kind,
        "x-chaos-fault-path": path,
        "x-chaos-fault-method": "GET",
      });
    c.observe({ headers: headers("5xx", "/a"), pageUrl: "https://app/a" });
    c.observe({ headers: headers("latency", "/b"), pageUrl: "https://app/b" });
    const events = c.drain();
    expect(events.map((e) => e.attrs["fault.path"])).toEqual(["/a", "/b"]);
  });

  it("drain() empties the buffer", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({
      headers: new Headers({
        "x-chaos-fault-kind": "5xx",
        "x-chaos-fault-path": "/x",
        "x-chaos-fault-method": "GET",
      }),
      pageUrl: "https://app",
    });
    expect(c.drain()).toHaveLength(1);
    expect(c.drain()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm --filter chaosbringer test -- server-fault-collector.test.ts
```

Expected: module not resolved.

- [ ] **Step 3: Implement the collector**

Create `packages/chaosbringer/src/server-fault-collector.ts`:

```ts
import { parseServerFaultHeaders } from "./server-fault-events.js";
import type { ServerFaultEvent } from "./types.js";

export interface ObserveArgs {
  headers: Headers;
  pageUrl: string;
}

/**
 * Buffers server-side fault events parsed from response headers across
 * the lifetime of a single crawl. The crawler creates one instance,
 * page-level listeners feed it, and the report generator drains it.
 */
export class ServerFaultCollector {
  private buffer: ServerFaultEvent[] = [];

  constructor(private readonly prefix: string) {}

  observe(args: ObserveArgs): void {
    const parsed = parseServerFaultHeaders(args.headers, this.prefix);
    if (!parsed) return;
    this.buffer.push({
      traceId: parsed.traceId,
      attrs: parsed.attrs,
      observedAt: Date.now(),
      pageUrl: args.pageUrl,
    });
  }

  drain(): ServerFaultEvent[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  size(): number {
    return this.buffer.length;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter chaosbringer test -- server-fault-collector.test.ts
```

Expected: green.

- [ ] **Step 5: Wire into the crawler**

In `packages/chaosbringer/src/crawler.ts`:

a) Add an import at the top with the other internal imports:

```ts
import { ServerFaultCollector } from "./server-fault-collector.js";
```

b) Inside `ChaosCrawler` (the class), declare a private field near the other private state:

```ts
  private readonly serverFaultCollector: ServerFaultCollector | null;
```

c) Initialise it in the constructor (after options are stored). Search for where `this.options` is assigned and append below it:

```ts
    this.serverFaultCollector = this.options.server?.mode === "remote"
      ? new ServerFaultCollector(this.options.server.responseHeaderPrefix ?? "x-chaos-fault")
      : null;
```

d) Inside the per-page listener block (the section near line 1364 that sets up `page.on("console", …)` etc), add:

```ts
    if (this.serverFaultCollector) {
      const collector = this.serverFaultCollector;
      page.on("response", (response) => {
        if (!collecting) return;
        // Playwright's APIResponse / Response gives a plain object via headers().
        // Wrap in Headers so the collector's parser sees a Web-Standard surface.
        const h = new Headers();
        for (const [k, v] of Object.entries(response.headers())) h.set(k, v);
        collector.observe({ headers: h, pageUrl: page.url() });
      });
    }
```

(`collecting` is the local boolean declared earlier in the same method that gates listeners during the page recovery window. Reusing it keeps server-fault events scoped to the same lifetime as console / pageerror listeners.)

- [ ] **Step 6: Run full test suite**

```bash
pnpm --filter chaosbringer test
```

Expected: green (no behaviour change to report yet — Task 13 surfaces drained events).

- [ ] **Step 7: Commit**

```bash
git add packages/chaosbringer/src/server-fault-collector.ts packages/chaosbringer/src/server-fault-collector.test.ts packages/chaosbringer/src/crawler.ts
git commit -m "feat(chaosbringer): collect server-fault events from response headers per page"
```

---

### Task 13: Surface events on `CrawlReport.serverFaults`

**Files:**
- Modify: `packages/chaosbringer/src/crawler.ts`
- Modify: `packages/chaosbringer/src/chaos.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/chaosbringer/src/chaos.test.ts` (or wherever `chaos.test.ts` lives — assert by `grep -l "describe(\"chaos" packages/chaosbringer/src/`). The new test exercises the integration without Playwright — by calling `generateReport` indirectly we'd need a full crawl. Instead, add a unit-level test that calls the crawler's report-generation path with the collector pre-seeded.

Use a smaller test file scope: create `packages/chaosbringer/src/server-fault-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ServerFaultCollector } from "./server-fault-collector.js";

describe("server-fault report integration", () => {
  it("collector.drain() produces the shape CrawlReport.serverFaults expects", () => {
    const c = new ServerFaultCollector("x-chaos-fault");
    c.observe({
      headers: new Headers({
        "x-chaos-fault-kind": "5xx",
        "x-chaos-fault-path": "/api/x",
        "x-chaos-fault-method": "GET",
        "x-chaos-fault-target-status": "503",
        "x-chaos-fault-trace-id": "abcdef0123456789abcdef0123456789",
      }),
      pageUrl: "https://app/x",
    });
    const drained = c.drain();
    // Shape contract that CrawlReport.serverFaults exposes:
    expect(drained[0]).toMatchObject({
      traceId: "abcdef0123456789abcdef0123456789",
      pageUrl: "https://app/x",
      attrs: {
        "fault.kind": "5xx",
        "fault.path": "/api/x",
        "fault.method": "GET",
        "fault.target_status": 503,
        "fault.trace_id": "abcdef0123456789abcdef0123456789",
      },
    });
    expect(typeof drained[0].observedAt).toBe("number");
  });
});
```

- [ ] **Step 2: Run, confirm it passes**

```bash
pnpm --filter chaosbringer test -- server-fault-report.test.ts
```

Expected: green (this test is a contract anchor — it pins the shape so future refactors break loudly).

- [ ] **Step 3: Wire drain into report generation**

In `packages/chaosbringer/src/crawler.ts`, find `generateReport` (around line 2236). Inside the returned `CrawlReport`, after the existing optional fields (`coverage`, `advisor`, etc.), add:

```ts
      ...(this.serverFaultCollector && this.serverFaultCollector.size() > 0
        ? { serverFaults: this.serverFaultCollector.drain() }
        : {}),
```

Order doesn't matter for the consumer, but keep it next to similarly conditional fields for readability.

If `generateReport` builds the object via property assignments rather than a single literal, append:

```ts
    if (this.serverFaultCollector && this.serverFaultCollector.size() > 0) {
      report.serverFaults = this.serverFaultCollector.drain();
    }
```

- [ ] **Step 4: Run full chaosbringer test suite**

```bash
pnpm --filter chaosbringer test
pnpm --filter chaosbringer build
```

Expected: green + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/chaosbringer/src/server-fault-report.test.ts packages/chaosbringer/src/crawler.ts
git commit -m "feat(chaosbringer): surface server fault events on CrawlReport.serverFaults"
```

---

### Task 14: Open PR 2

**Files:** none modified.

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin feat/chaos-server-mode-remote
gh pr create --title "feat(chaosbringer): server: { mode: 'remote' } ingests x-chaos-fault-* headers" --body "$(cat <<'EOF'
## Summary
- New `chaos({ server: { mode: "remote" } })` option attaches a `page.on('response', …)` listener that parses `x-chaos-fault-*` response headers emitted by `@mizchi/server-faults`'s `metadataHeader`.
- Events surface on `CrawlReport.serverFaults` as a flat list with `traceId`, `attrs` (FaultAttrs schema), `observedAt`, `pageUrl`.
- Per-action correlation is left to consumers via `traceId` join — explicitly Phase 2 territory.

Spec: `docs/superpowers/specs/2026-05-06-chaos-server-orchestration-design.md`

Refs: closes part of #56 (chaosbringer side). Depends on the server-faults release shipped with the previous PR.

## Test plan
- [x] `pnpm --filter chaosbringer test` passes locally
- [x] `pnpm --filter chaosbringer build` succeeds
- [ ] otel-chaos-lab adoption PR will be the live end-to-end verification (separate PR)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** server-faults trace_id (Task 1), verdict refactor (Task 2), metadataHeader option (Task 3), all four adapters updated (Tasks 4–7), chaosbringer remote mode option (Task 11), response listener (Task 12), report surface (Task 13). otel-chaos-lab adoption is intentionally a separate plan as per spec.
- **No placeholders:** every TDD step has concrete code. Adapter test deltas show the full new test bodies, not "similar to above".
- **Type consistency:** `FaultAttrs`, `FaultVerdict`, `metadataHeader`, `ChaosRemoteServer`, `ServerFaultEvent`, `ServerFaultCollector` are introduced in Tasks 1–3 and 10–12 in the order they're consumed; `parseServerFaultHeaders` (Task 10) is consumed by `ServerFaultCollector` (Task 12); `ChaosRemoteServer` (Task 11) is read by the crawler init in Task 12.
- **Sequencing:** `attrsToHeaderEntries` and `resolveMetadataPrefix` are exported from server-faults.ts in Task 3, then consumed in Tasks 4–7 — the export must land before the adapter PRs are run, which is enforced by Task ordering within PR 1.
- **Breaking change discipline:** Tasks 4–7 are intentionally broken between commits inside PR 1; CI on the branch will fail until Task 7 lands. Reviewers should review the PR as a unit, not commit-by-commit. Documented inside Task 2.
