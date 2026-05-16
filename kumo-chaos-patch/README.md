# kumo-chaos-patch

Additive Go patch for [sivchari/kumo](https://github.com/sivchari/kumo) that adds runtime-mutable
chaos endpoints (`/kumo/chaos/*`). Designed to layer on top of [PR #667 (latency emulator)](https://github.com/sivchari/kumo/pull/667) without colliding with it.

Why a separate package and not "extend latency"?
- PR #667 is **startup-only** by design — rules load from `KUMO_LATENCY_CONFIG` and never change.
  That's the right shape for baseline latency in CI.
- Chaos drills need **runtime control** — a drill installs faults, observes impact, removes them,
  re-runs with different parameters. Mixing the two surfaces would break #667's "rules are immutable
  for the life of the process" invariant.

So `internal/chaos` reuses #667's `awsapi.RequestInfo`, `servicecatalog`, and `latency.Latency`
types — but holds its own engine that supports `UpsertRule` / `DeleteRule` / `Clear` at runtime.

## Layout

```
internal/
  chaos/
    types.go        # Rule, Inject, Decision, Stats — JSON wire types
    engine.go       # runtime-mutable rule storage + Evaluate()
    awserrors.go    # protocol-aware AWS error responses (JSON/Query/REST)
  server/
    chaos_handlers.go  # POST/GET/DELETE /kumo/chaos/rules{,/{id}} + /kumo/chaos/stats
    chaos_wire.go      # SetChaosEngine() + evaluateChaos() hook
```

## Wiring into kumo

This patch is **additive** but requires three small in-place edits to existing kumo files:

### 1. `internal/server/server.go`

Add a `ChaosEnabled bool` to `Config` and a `chaosEngine *chaos.Engine` to `Server`:

```go
type Config struct {
    // ...existing fields...
    LatencyConfig string
    ChaosEnabled  bool   // NEW: enables /kumo/chaos/* admin endpoints
}

type Server struct {
    // ...existing fields...
    latencyEngine *latency.Engine
    chaosEngine   *chaos.Engine  // NEW
}
```

Inside `New(config Config)`, after the latency-engine block:

```go
if config.ChaosEnabled || os.Getenv("KUMO_CHAOS_ENABLED") == "1" {
    srv.SetChaosEngine(chaos.NewEngine(catalog))
}
```

### 2. `internal/server/router.go`

Add a `chaosEngine *chaos.Engine` field to `Router` (next to `latencyEngine`).

In `wrapHandler()`, replace the latency block with one that runs both layers:

```go
// existing #667 latency hook stays as-is
if decision := r.evaluateLatency(&info); decision != nil && decision.Delay > 0 {
    sleep(decision.Delay, req.Context())
}

// NEW: chaos hook — may short-circuit
if r.evaluateChaos(&info, wrapped, req) {
    return
}

handler(wrapped, req)
```

(See `chaos_wire.go` for the exact `evaluateChaos` signature.)

### 3. `cmd/kumo/main.go`

Honor `KUMO_CHAOS_ENABLED=1` so `kumo --chaos` / env-var enables the endpoints
without code changes in downstream callers.

## API reference

All endpoints are JSON. Available only when chaos is enabled.

### `POST /kumo/chaos/rules`

Add or replace a rule by ID.

```json
{
  "id": "ddb-throttle-storm",
  "enabled": true,
  "match": { "service": "dynamodb", "action": "PutItem" },
  "inject": {
    "kind": "throttle",
    "probability": 0.3,
    "awsError": {
      "code": "ProvisionedThroughputExceededException"
    }
  }
}
```

`inject.kind` is one of:

| Kind | Behavior |
|---|---|
| `latency` | Sleep, then call the real handler. `inject.latency` reuses #667's `Latency` shape (`fixedMs` *or* `p50Ms`/`p95Ms`/`p99Ms`/`maxMs`). |
| `disconnect` | Hijack and close the TCP connection. `inject.disconnect = { style, afterMs }`. SDKs see unexpected EOF, exercising retry loops. |
| `awsError` | Synthetic AWS error response with proper envelope (JSON 1.0 / Query XML / REST XML) chosen from the matched request's protocol. `inject.awsError = { code, httpStatus?, message? }`. |
| `throttle` | Same as `awsError` but `httpStatus` defaults to 400 and the code defaults to a service-appropriate throttling code. |

`probability` (0..1) gates per-request: `1.0` = every match, `0.3` = 30% of matches.

### `GET /kumo/chaos/rules`

Returns `{ "rules": [...], "stats": [...] }` (current rules + per-rule counters).

### `DELETE /kumo/chaos/rules/{id}`

Remove one rule.

### `DELETE /kumo/chaos/rules`

Remove all rules. Common at drill teardown.

### `GET /kumo/chaos/stats`

Returns `[{ ruleId, matched, skipped, lastApply }, ...]`. `matched` = rule won the probability roll; `skipped` = matched but lost the roll.

## Apply

```sh
# from a kumo checkout
cp -r /path/to/chaosbringer/kumo-chaos-patch/internal/chaos internal/
cp /path/to/chaosbringer/kumo-chaos-patch/internal/server/chaos_*.go internal/server/
# then apply the 3 in-place edits described above
go build ./...
go test ./internal/chaos/...
```

A proper upstream PR would split these into one commit per concern; this layout is optimized for
"read in one sitting and apply by hand to a fork."
