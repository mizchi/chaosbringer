# Production-safe recipe runs

Two features that make the recipe layer production-ready: storage
state snapshots (cut the `requires` chain cost) and recipe rollback
(undo a bad `repairRecipe`).

| Feature | Issue | Solves |
|---|---|---|
| Storage state snapshot | [#89](https://github.com/mizchi/chaosbringer/issues/89) | "We're running `auth/login` 100× per load test" |
| Recipe version history + rollback | [#90](https://github.com/mizchi/chaosbringer/issues/90) | "`repairRecipe` made the recipe worse and we can't get the old one back" |

## Snapshot fast-path for `requires` chains

When a recipe like `auth/login` is a prerequisite for many dependents,
replaying it every iteration burns Chromium time. Enable
`snapshot: true` on `runRecipeWithRequires` (or `scenarioLoadFromStore`
under the hood) and the runner will:

1. On the first replay, capture `page.context().storageState()` after
   the chain link succeeds and persist it next to the recipe
   (`<dir>/auth__login.state.json`).
2. On subsequent replays in fresh contexts, inject the cookies +
   localStorage into the new context and **skip the chain link
   entirely** — fired as `kind: "skip", reason: "snapshot-applied"`
   in the `onProgress` stream.

```ts
import {
  RecipeStore,
  runRecipeWithRequires,
  scenarioLoadFromStore,
} from "chaosbringer";

const store = new RecipeStore();

// Recipes already in store: auth/login, shop/checkout (requires auth/login).

// Programmatic:
await runRecipeWithRequires({
  page,
  recipe: store.get("shop/checkout")!,
  store,
  snapshot: true,           // ← enables fast-path
});

// scenarioLoad bridge — every worker iteration benefits.
await scenarioLoadFromStore({
  baseUrl: "http://localhost:3000",
  store,
  workers: 10,
  duration: "5m",
  // No explicit `snapshot: true` here yet — pass it via a custom
  // `recipeStoreScenario` if you need control. (Default behaviour
  // is conservative: snapshots OFF until you opt in.)
});
```

### Snapshot lifecycle

| Event | Effect |
|---|---|
| Recipe edits → `version` bumps | Old snapshot's `recipeVersion` mismatches, snapshot is dropped on next access |
| TTL elapses (default 30 min) | Snapshot dropped, chain link replays normally + recaptures |
| Origin mismatch on apply | Snapshot refuses to load (cross-host protection) |
| Format version bumps (`SNAPSHOT_FORMAT_VERSION`) | All older snapshots invalidated |
| Corrupt JSON | Auto-deleted on next access |

Customise via the policy object:

```ts
await runRecipeWithRequires({
  ...,
  snapshot: {
    ttlMs: 5 * 60 * 1000,                        // 5-min TTL
    eligible: (r) => r.name.startsWith("auth/") || r.name.startsWith("setup/"),
  },
});
```

The `eligible` predicate is the safety knob: snapshots should only
apply to recipes whose **post-state is stable and replayable**. Anything
that touches server-side state (placing an order, creating a record)
should NOT be eligible.

### What gets captured

Snapshots store the same shape Playwright's
`context.storageState()` returns:

- All cookies on every origin the context has seen
- localStorage for every origin
- sessionStorage is NOT in storageState; it doesn't survive the
  context anyway

Not captured:
- IndexedDB
- Service Worker registrations
- WebSockets (always transient)
- HTTP cache (Playwright doesn't expose it)

For flows that depend on those, snapshots will silently produce
wrong results — that's why the eligibility predicate is the
escape hatch.

## Recipe version history + rollback

`repairRecipe` bumps `recipe.version` after the AI patches the failing
tail. With version history, the prior step list isn't lost — it's
archived next to the current file.

### Reviewing the history

```ts
const history = store.history("shop/checkout");
for (const r of history) {
  console.log(`v${r.version}: ${r.steps.length} steps, last used ${new Date(r.stats.lastSuccessAt!).toISOString()}`);
}
```

`history()` returns newest first; the **current** version is NOT in
the list — call `store.get("shop/checkout")` for that.

### Reverting a bad repair

```ts
const rolled = store.rollback("shop/checkout", { toVersion: 2 });
console.log(`now at v${rolled!.version}`);   // a NEW version, not v2
```

What `rollback` does:
1. Find the requested historical version (returns null if missing).
2. Archive the current version as `vN.json` so the rollback is
   itself reversible.
3. Promote the historical version to current, with a **fresh version
   number** (max(known versions) + 1) so downstream version checks
   see a clear change.
4. **Preserve current stats** (`successCount` / `failCount` /
   `avgDurationMs`) — rollback is a step-list swap, not a stats reset.
5. Tag with `requires: ["__rolled-back-from-vN"]` for provenance.

### Cleaning up old versions

Keep the library hygienic:

```ts
const deleted = store.pruneHistory("shop/checkout", { keepLast: 5 });
console.log(`pruned ${deleted} old versions`);
```

Recommended for projects that auto-repair frequently: `keepLast: 5`
is enough to roll back a recent regression without bloating git.

## File layout

```
chaosbringer-recipes/
  shop__checkout.json              # current — what recipeDriver replays
  shop__checkout.v3.json           # archived prior version
  shop__checkout.v2.json           # archived prior version
  shop__checkout.state.json        # storage-state snapshot (issue #89)
  auth__login.json                 # current
  auth__login.state.json           # active snapshot
```

The store loader filters out `.vN.json` and `.state.json` siblings —
they're never picked up as recipes. Hand-edit the current `name.json`
freely; the archive layer doesn't get in the way.

## Gotchas

- **Snapshots are intra-host only.** A snapshot captured against
  `staging.example.com` will NOT apply to `prod.example.com` — the
  `applySnapshot` check requires origin parity. By design.
- **Rollback doesn't validate.** `rollback({ toVersion: 1 })` will
  happily restore a v1 that was demoted for a reason. Pair with
  `verifyAndPromote` after a rollback to be sure.
- **Snapshot does NOT replace `auth/login` for the terminal recipe.**
  Snapshots only short-circuit *chain links*, not the recipe you're
  ultimately trying to run. So the recipe at the end of the chain
  always replays.
- **Stats survive across rollback but not across snapshot misses.**
  When a snapshot expires and the chain link re-replays, the chain
  link's stats are updated normally — the snapshot doesn't suppress
  them.
- **Two parallel workers can race on snapshot writes.** Last-writer-wins
  via atomic rename — no corruption, but if two workers capture
  storage state for the same recipe in the same window, only one
  survives. Practically harmless.

## Related

- The `requires` chaining feature: [`./recipe-composition.md`](./recipe-composition.md)
- The `repairRecipe` flow: [`./browser-harness-concepts.md`](./browser-harness-concepts.md)
- Per-worker auth via `storageState` (different mechanism, similar goal): [`./per-worker-auth.md`](./per-worker-auth.md)
