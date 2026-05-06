# @mizchi/cf-faults

Cloudflare Workers-specific chaos injection. Targets the failure modes that don't fit cleanly into HTTP-level chaos:

- **KV namespaces** — make `get` / `put` / `delete` / `list` throw or return null
- **Service Bindings** — make `env.X.fetch()` return a synthetic 5xx or abort

The wrappers are drop-in (same shape as the underlying binding), so application code is unchanged. Each fault is surfaced through an `observer.onFault` hook with the same `fault.*` attribute schema as [`@mizchi/server-faults`](../server-faults), so a single OTel pipeline catches both layers.

## Install

```bash
pnpm add @mizchi/cf-faults
```

Requires Node 20+. The package is zero-dep; no `@cloudflare/workers-types` requirement on consumers — bindings are matched structurally.

## Usage

### KV namespace

```ts
import { wrapKv } from "@mizchi/cf-faults";

const todos = wrapKv(env.TODOS, {
  rate: 0.1,
  kinds: ["throw", "miss"],   // any subset of "throw" | "miss"
  bindingName: "TODOS",       // shows up as fault.target on observer events
  seed: 42,                   // reproducible run; omit for Math.random
  observer: {
    onFault: (kind, attrs) => myMetric.add(1, { kind, target: attrs["fault.target"] }),
  },
});

// use `todos` exactly like the original env.TODOS
const t = await todos.get(id); // ← may throw or be null
```

| Kind | Effect | Applies to |
|---|---|---|
| `"throw"` | Reject the call with a synthetic Error | `get`, `put`, `delete`, `list` |
| `"miss"` | Resolve `get` to `null` regardless of underlying value | `get` only (other ops fall through) |

### Service Binding

```ts
import { wrapServiceBinding } from "@mizchi/cf-faults";

const enricher = wrapServiceBinding(env.ENRICHER, {
  status5xxRate: 0.3,
  status5xxCode: 503,
  abortRate: 0.05,
  bindingName: "ENRICHER",
  seed: 42,
  observer: {
    onFault: (kind, attrs) => myMetric.add(1, { kind, target: attrs["fault.target"] }),
  },
});

const res = await enricher.fetch("https://enricher/enrich", { method: "POST", body });
```

5xx and abort are independent raffles (5xx is rolled first). At `status5xxRate=1, abortRate=1` the 5xx wins, mirroring `@mizchi/server-faults`'s "single fault per request" semantics.

## Observer schema

`observer.onFault(kind, attrs)` follows the `fault.*` namespace shared with `@mizchi/server-faults`:

| Attribute | Required | Notes |
|---|---|---|
| `fault.kind` | always | `"kv.throw" \| "kv.miss" \| "service.5xx" \| "service.abort"` |
| `fault.target` | when set | KV / Service binding name |
| `fault.path` | always | KV op label (`get:KEY`) or service URL pathname |
| `fault.target_status` | for `service.5xx` | the synthetic HTTP status |

The shared schema means a single OTel counter (`fault.injections_total`) can aggregate across server-side and Cloudflare-binding chaos.

## Why a separate package

Server-side fault injection (`@mizchi/server-faults`) operates on Web Standard `Request` / `Response` and is framework-agnostic. KV / Service Binding aren't on that surface — they're Cloudflare runtime APIs with their own shapes — so layering them onto server-faults would muddy its contract. Splitting keeps server-faults framework-agnostic and lets `cf-faults` evolve without holding it back.

## License

MIT
