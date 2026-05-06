# Chaos × server-faults orchestration — Phase 2: per-action and per-page correlation

**Date:** 2026-05-06
**Issue:** [chaosbringer#56](https://github.com/mizchi/chaosbringer/issues/56)
**Status:** Approved (awaiting implementation plan)
**Builds on:** [Phase 1 spec](2026-05-06-chaos-server-orchestration-design.md), shipped in PR #74 + #75.

## Problem

Phase 1 surfaced server-side fault events on `CrawlReport.serverFaults` as a flat array. To answer the natural investigation questions — *"which page was active when the fault fired?"* and *"which user action triggered the fault?"* — consumers must filter manually:

```ts
// the recipe at docs/recipes/server-side-correlation.md gestures at this
for (const action of report.actions) {
  const trace = action.traceparent?.match(/^00-([0-9a-f]{32})/)?.[1]; // ← does not exist
  if (!trace) continue;
  const matchingFaults = report.serverFaults?.filter(e => e.traceId === trace) ?? [];
  …
}
```

Two breakages:

1. `ActionResult` does **not** record the traceparent. The recipe is aspirational. Consumers cannot in fact join by trace-id at the action level today.
2. Even for page-level joins (where `ServerFaultEvent.pageUrl` is already populated), the user has to write the same `report.serverFaults.filter(e => e.pageUrl === page.url)` boilerplate every time.

Phase 2 makes both joins first-class on the report.

## Scope

In scope (Phase 2 ships both as one PR — recipe rewrite is one pass):

- **(γ) Per-page correlation:** `PageResult.serverFaultEvents?: ServerFaultEvent[]`, populated at report finalization by joining `report.serverFaults` on `pageUrl`.
- **(α) Per-action correlation:** `ActionResult.traceIds?: string[]` and `ActionResult.serverFaultEvents?: ServerFaultEvent[]`, populated by capturing trace-ids during the action's execution window and joining `report.serverFaults` on those ids.

Out of scope (separate Phase 2 sub-issues if needed):

- Same-process integration (`server: ServerFaultHandle` direct passing). Original issue text proposed this, but no demand surfaced; defer.
- Auto-seed propagation between processes. Requires a server-side control surface; defer.

## Architecture

### Per-page (γ) — pre-computed view

`ServerFaultEvent` already carries `pageUrl: string`. The "join" is a `filter`. Pre-compute it once during `ChaosCrawler.generateReport()`:

```ts
for (const page of pages) {
  const events = report.serverFaults?.filter(e => e.pageUrl === page.url);
  if (events && events.length > 0) page.serverFaultEvents = events;
}
```

References are shared between `report.serverFaults[]` and `page.serverFaultEvents[]` — no data duplication, just two views over the same array.

### Per-action (α) — current-action tracking

A click can fire N HTTP requests. Each request gets its own traceparent (PR #72). Action-level correlation needs to capture *all* trace-ids emitted while a given action is "in flight".

Mechanism:

1. `ChaosCrawler` keeps a private `currentAction: ActionResult | null` field.
2. The action loop sets `this.currentAction = result` immediately before invoking `performActionOnTarget`, and clears it at the start of the next iteration (not at the end of the current action — late-firing requests after `click()` resolves should still attach).
3. The traceparent injection site in `setupNavigationBlocking` already calls `traceparentHook?.({ traceId, … })`. Add an internal hook *before* that consumer hook that appends `traceId` to `this.currentAction?.traceIds ?? []`.
4. When `currentAction` is `null` (between actions, during initial page load), trace-ids are still recorded on `report.serverFaults` (via Phase 1 wiring) and surface via `PageResult.serverFaultEvents`. They simply do not get a per-action attribution.

Edge cases:

- **Action triggers no requests** (scroll, hover): `traceIds` stays absent. `serverFaultEvents` stays absent. The empty-array distinction matters less than the absent-field signal.
- **Action triggers requests *after* it appears to complete** (e.g. a click fires a fetch that resolves 500ms later, still during chaosbringer's `between actions` window): the fetch's trace-id is captured if the next action hasn't started yet; otherwise it attaches to the next action. This is approximate but matches what a human investigator would naturally infer.
- **Navigation actions** that load a new page: the page-load requests fire under the click action's window. Captured. Subsequent in-page requests fire after the next action starts and attach there.

### Data model changes (types.ts)

```ts
export interface PageResult {
  // … existing fields …
  /**
   * Server-side fault events that fired while this page was active.
   * Pre-computed view of `report.serverFaults` filtered by `pageUrl`.
   * Populated only when `chaos({ server: { mode: "remote" } })` was set
   * AND faults were observed on this page; absent otherwise.
   */
  serverFaultEvents?: ServerFaultEvent[];
}

export interface ActionResult {
  // … existing fields …
  /**
   * W3C trace-ids of requests triggered while this action was executing.
   * Populated only when `chaos({ traceparent: true })` is set. Empty for
   * actions that triggered no requests (scroll, hover).
   */
  traceIds?: string[];
  /**
   * Server-side fault events whose `traceId` is in `traceIds[]`. Pre-
   * computed view of `report.serverFaults` per action. Populated only when
   * `chaos({ traceparent: true, server: { mode: "remote" } })` is both set.
   */
  serverFaultEvents?: ServerFaultEvent[];
}
```

Both fields are additive. No breaking change to consumers.

### Activation matrix

| `traceparent` set | `server: { mode: "remote" }` set | What's populated |
|---|---|---|
| no | no | `report.serverFaults` absent. No correlation. |
| no | yes | `report.serverFaults`, `PageResult.serverFaultEvents`. No `ActionResult.serverFaultEvents` (no trace-ids to join on). |
| yes | no | `ActionResult.traceIds`. No fault events anywhere. |
| yes | yes | All four fields populated. The intended Phase 2 surface. |

The recipe at `docs/recipes/server-side-correlation.md` will be updated to require both options together for full correlation, with the activation matrix documented.

## Component changes

### `packages/chaosbringer/src/crawler.ts`

1. Add `private currentAction: ActionResult | null = null;` to `ChaosCrawler`.
2. In the per-page action loop (around line 2000), wrap each iteration:
   ```ts
   this.currentAction = candidateResult; // set BEFORE performActionOnTarget
   const result = await this.performActionOnTarget(page, …);
   // do NOT clear here — late-firing requests still attach
   ```
   Clear at the *start* of the next iteration (or at page-end finalisation).
3. In `setupNavigationBlocking`, in the synthesised-traceparent branch (around line 1187), before the existing `traceparentHook?.(…)` call:
   ```ts
   if (this.currentAction) {
     this.currentAction.traceIds ??= [];
     this.currentAction.traceIds.push(traceId);
   }
   ```
4. In `generateReport()` (around line 2280), after the existing `serverFaults` field is computed:
   ```ts
   if (drainedEvents.length > 0) {
     // Per-page join
     for (const p of this.pages) {
       const events = drainedEvents.filter(e => e.pageUrl === p.url);
       if (events.length > 0) p.serverFaultEvents = events;
     }
     // Per-action join (only when traceparent injection was on)
     for (const a of this.actions) {
       if (!a.traceIds || a.traceIds.length === 0) continue;
       const set = new Set(a.traceIds);
       const events = drainedEvents.filter(e => e.traceId && set.has(e.traceId));
       if (events.length > 0) a.serverFaultEvents = events;
     }
   }
   ```

### `packages/chaosbringer/src/types.ts`

Add the two optional fields per the model above with JSDoc explaining the activation requirements.

### `packages/chaosbringer/src/server-fault-collector.ts`

No change. The collector still produces flat events; the join is a generateReport-level concern.

## Recipe updates

`docs/recipes/server-side-correlation.md` is rewritten to:

1. Replace the manual-filter pseudo-code with the new fields.
2. Document the activation matrix (both options together for full correlation).
3. Show the canonical investigation pattern:
   ```ts
   // "what server faults fired on the page that broke?"
   const failedPages = report.pages.filter(p => p.errors.length > 0);
   for (const p of failedPages) {
     console.log(p.url, p.serverFaultEvents?.map(e => e.attrs.kind));
   }
   // "which click triggered the 503?"
   const fivexx = report.serverFaults?.filter(e => e.attrs.kind === "5xx") ?? [];
   for (const f of fivexx) {
     const action = report.actions.find(a => a.serverFaultEvents?.includes(f));
     console.log(`5xx on ${f.attrs.path} triggered by`, action?.target);
   }
   ```

## examples/cloudflare-worker adoption

`examples/cloudflare-worker/chaos/run.ts` adds `traceparent: true` to the `chaos()` options so the demo actually demonstrates Phase 2. The existing `test.mjs` continues to assert `server-side fault events: N > 0`; an additional grep can confirm at least one event is attached to an action (i.e. `report.actions[i].serverFaultEvents` non-empty).

## Testing strategy

### Unit tests (chaosbringer)

- **Per-page join**: feed a fake `generateReport`-input state with synthetic events whose `pageUrl` matches some pages; assert `pages[i].serverFaultEvents` populated correctly. Pages with no events get no field.
- **Per-action join**: synthetic state with `actions[i].traceIds` populated; assert `actions[i].serverFaultEvents` after join. Actions with no `traceIds` get no field.
- **Activation matrix**: with traceparent off, assert `actions[i].serverFaultEvents` always absent. With server off, assert no fault-events anywhere.

### Integration

The cloudflare-worker example test (`examples/cloudflare-worker/test.mjs`) already runs the full stack. Extend the assertion: after `server-side fault events: N > 0` matches, also assert that *some* action carried a `serverFaultEvents` field (parse the report file directly). That pins the new wiring end-to-end.

### Non-goals for tests

- Behaviour of N concurrent actions (chaosbringer is single-action serial within a page; concurrency is out of scope).
- Reconciling drift between Phase 1 collector timestamps and Phase 2 trace-id captures (the trace-id join is exact; timestamp-based fallback is unnecessary).

## Risks and mitigations

- **Action boundary races.** A late-firing request whose trace-id is captured AFTER `currentAction` was already cleared would land on the next action — incorrect attribution. Mitigated by clearing on next-action-start (not current-action-end). True races (request fires between iterations) are inherent to the asynchronous click→fetch model; document the heuristic.
- **Memory: `traceIds[]` could grow on action-heavy pages.** A page with 50 actions × 5 requests each = 250 strings × 32 chars = ~8KB per page. Negligible.
- **Backwards compatibility of `ActionResult` shape.** Adding optional fields is additive. Consumers iterating `report.actions[]` see no break.
- **Same trace-id appearing in multiple actions.** Possible if the user retries an action OR the chaosbringer crawler aborts and reissues. Both fields surface the trace-id under whichever action was current at injection time. The fault event would attach to ALL actions whose `traceIds` contains it — the join uses `.includes`. In practice trace-ids are 32-hex random; collisions across actions are vanishingly unlikely.

## Sequencing

One PR:

1. types.ts: add `PageResult.serverFaultEvents` + `ActionResult.traceIds` + `ActionResult.serverFaultEvents`. Test for shape only (no behaviour).
2. crawler.ts: `currentAction` tracking, internal trace-id hook, generateReport joins. Unit tests pass.
3. Recipe rewrite + example update + test extension.
4. Open PR; merge after CI green.

No upstream `@mizchi/server-faults` changes required. Phase 2 is chaosbringer-internal.
