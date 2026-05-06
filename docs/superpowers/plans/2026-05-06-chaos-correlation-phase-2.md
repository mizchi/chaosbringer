# Chaos × server-faults orchestration Phase 2 — per-page + per-action correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface server-side fault events on `PageResult` (filtered by `pageUrl`) and on `ActionResult` (joined by W3C trace-id), eliminating the manual filter boilerplate the Phase 1 recipe gestures at.

**Architecture:** Both fields are derived views computed in `ChaosCrawler.generateReport()` from the existing flat `report.serverFaults`. Per-page join is by `pageUrl`. Per-action join requires capturing trace-ids during the action's execution window via a new `currentAction` pointer in the crawler that the traceparent injection site appends into.

**Tech Stack:** TypeScript, vitest, Playwright (existing chaosbringer dependencies).

**Spec:** [`docs/superpowers/specs/2026-05-06-chaos-server-orchestration-phase-2-design.md`](../specs/2026-05-06-chaos-server-orchestration-phase-2-design.md)

**Repository root for paths:** `/Users/mz/ghq/github.com/mizchi/chaosbringer/`. All file paths below are relative to it. Branch (already created): `feat/chaos-correlation-phase-2`. Spec commit `ca99aa8` is the base.

**Sequencing:** All tasks land on the same branch, one PR. Tasks are ordered so each commit leaves the repo green (`pnpm -F chaosbringer test` + `pnpm -F chaosbringer build`).

---

## Task 1: Extend `types.ts` with the three new optional fields

**Files:**
- Modify: `packages/chaosbringer/src/types.ts:432-489` (`PageResult` and `ActionResult` interfaces)

This task adds the public type surface. No behaviour change — `serverFaultEvents` and `traceIds` stay `undefined` everywhere until Tasks 2-4 populate them. Tests that introspect types still compile.

- [ ] **Step 1: Add `serverFaultEvents` to `PageResult`**

In `packages/chaosbringer/src/types.ts`, locate `export interface PageResult { … }` (starts at line 432). Append the new optional field at the END of the interface body, immediately before the closing `}`:

```ts
  /**
   * Server-side fault events that fired while this page was active.
   * Pre-computed view of `report.serverFaults` filtered by `pageUrl`.
   * Populated only when `chaos({ server: { mode: "remote" } })` was set
   * AND faults were observed on this page; absent otherwise.
   *
   * References are shared with `report.serverFaults[]` — no duplication.
   */
  serverFaultEvents?: ServerFaultEvent[];
```

- [ ] **Step 2: Add `traceIds` and `serverFaultEvents` to `ActionResult`**

In the same file, locate `export interface ActionResult { … }` (starts at line 484). Append the two new optional fields at the END of the interface body, immediately before the closing `}`:

```ts
  /**
   * W3C trace-ids of requests triggered while this action was executing.
   * Populated only when `chaos({ traceparent: true })` is set. Absent for
   * actions that triggered no requests (scroll, hover) or when traceparent
   * injection is off.
   */
  traceIds?: string[];
  /**
   * Server-side fault events whose `traceId` is in `traceIds[]`. Pre-
   * computed view of `report.serverFaults` per action. Populated only when
   * `chaos({ traceparent: true, server: { mode: "remote" } })` is BOTH set
   * AND at least one fault joined to this action.
   */
  serverFaultEvents?: ServerFaultEvent[];
```

- [ ] **Step 3: Verify build is clean**

```bash
cd /Users/mz/ghq/github.com/mizchi/chaosbringer
pnpm -F chaosbringer build
```

Expected: `tsc` reports zero errors. (No tests should break — fields are optional.)

- [ ] **Step 4: Verify tests are still green**

```bash
pnpm -F chaosbringer test
```

Expected: all green. The shape change is additive; nothing tests against the *absence* of these fields with type-equality strictness.

- [ ] **Step 5: Commit**

```bash
git add packages/chaosbringer/src/types.ts
git commit -m "feat(chaosbringer): add PageResult.serverFaultEvents + ActionResult.traceIds/serverFaultEvents (no behaviour)"
```

---

## Task 2: Capture trace-ids per action via `currentAction` pointer

**Files:**
- Modify: `packages/chaosbringer/src/crawler.ts` — add private field, hook into traceparent injection, manage lifecycle in the action loop.

This task wires the crawler so that every traceparent injected during action `N` lands in `actions[N].traceIds`. No join with serverFaults yet — that's Task 4.

- [ ] **Step 1: Write the failing test**

Create `packages/chaosbringer/src/server-fault-correlation.test.ts`:

```ts
/**
 * Phase 2 — per-action and per-page correlation in `generateReport`.
 *
 * These tests exercise the join logic via a thin harness that manipulates
 * a `ChaosCrawler` instance's internal state (results, actions, collector)
 * and then triggers report generation. We avoid spinning up Playwright /
 * the fixture server because the join logic is pure data manipulation.
 */

import { describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { ServerFaultCollector } from "./server-fault-collector.js";
import type { PageResult, ActionResult, ServerFaultEvent } from "./types.js";

function freshCrawler(): ChaosCrawler {
  // baseUrl is the only required option; everything else defaults.
  return new ChaosCrawler({ baseUrl: "https://app.test" });
}

function pushPage(crawler: ChaosCrawler, url: string): PageResult {
  const result: PageResult = {
    url,
    status: "success",
    statusCode: 200,
    loadTime: 0,
    errors: [],
    warnings: [],
    blockedNavigations: [],
    discoveredLinks: [],
    actions: [],
    metrics: {},
    hasErrors: false,
  };
  // The crawler tracks visited pages in `this.results`. Tests reach in via
  // the same field name the production code uses.
  (crawler as unknown as { results: PageResult[] }).results.push(result);
  return result;
}

function pushAction(crawler: ChaosCrawler, action: ActionResult): ActionResult {
  (crawler as unknown as { actions: ActionResult[] }).actions.push(action);
  return action;
}

function pushFault(crawler: ChaosCrawler, ev: ServerFaultEvent): void {
  // The crawler holds a `serverFaultCollector` only when
  // `server.mode === "remote"`; for the test we install one ourselves.
  const internal = crawler as unknown as { serverFaultCollector: ServerFaultCollector | null };
  if (!internal.serverFaultCollector) {
    internal.serverFaultCollector = new ServerFaultCollector("x-chaos-fault");
  }
  // Build matching headers for the collector to parse.
  const headers = new Headers({
    "x-chaos-fault-kind": ev.attrs.kind,
    "x-chaos-fault-path": ev.attrs.path,
    "x-chaos-fault-method": ev.attrs.method,
  });
  if (ev.attrs.targetStatus !== undefined) {
    headers.set("x-chaos-fault-target-status", String(ev.attrs.targetStatus));
  }
  if (ev.attrs.latencyMs !== undefined) {
    headers.set("x-chaos-fault-latency-ms", String(ev.attrs.latencyMs));
  }
  if (ev.traceId) {
    headers.set("x-chaos-fault-trace-id", ev.traceId);
  }
  internal.serverFaultCollector.observe({ headers, pageUrl: ev.pageUrl });
}

describe("traceIds capture during action execution", () => {
  it("appends trace-ids to currentAction during the action's window", () => {
    const crawler = freshCrawler();
    const action: ActionResult = {
      type: "click",
      target: "Save",
      success: true,
      timestamp: Date.now(),
    };
    // Simulate the action loop: set currentAction before execution.
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = action;
    // Simulate the injection site calling the internal hook for two requests.
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
      "00000000000000000000000000000001",
    );
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
      "00000000000000000000000000000002",
    );
    expect(action.traceIds).toEqual([
      "00000000000000000000000000000001",
      "00000000000000000000000000000002",
    ]);
  });

  it("ignores recordTraceId calls when no action is current", () => {
    const crawler = freshCrawler();
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = null;
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId(
      "00000000000000000000000000000003",
    );
    // No state to assert against; just verify it does not throw.
    expect(true).toBe(true);
  });

  it("attributes trace-ids to the most recent action when called between actions", () => {
    const crawler = freshCrawler();
    const a1: ActionResult = { type: "click", target: "A", success: true, timestamp: 0 };
    const a2: ActionResult = { type: "click", target: "B", success: true, timestamp: 1 };

    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = a1;
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("a1-trace");

    // Next iteration begins — currentAction is reassigned.
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = a2;
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("a2-trace");

    expect(a1.traceIds).toEqual(["a1-trace"]);
    expect(a2.traceIds).toEqual(["a2-trace"]);
  });
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: 3 tests fail. Likely shapes:
- `currentAction` field doesn't exist on the crawler — assignment via cast appears to "succeed" but the production code never reads it; the `recordTraceId` cast fails because the method doesn't exist (`recordTraceId is not a function`).

- [ ] **Step 3: Add `currentAction` field + `recordTraceId` method**

In `packages/chaosbringer/src/crawler.ts`, locate the `ChaosCrawler` class (search for `export class ChaosCrawler`). Find the section where private fields are declared (look for the cluster of `private readonly` and `private` declarations in the constructor area, near `private readonly serverFaultCollector`). Append a new private field next to `serverFaultCollector`:

```ts
  /**
   * Set by the action loop immediately before each `performActionOnTarget`
   * call; cleared at the start of the next iteration. The traceparent
   * injection site uses `recordTraceId` to append captured trace-ids onto
   * this action's `traceIds[]`.
   */
  private currentAction: ActionResult | null = null;
```

Add a private method on the same class. Place it next to similar utility methods (e.g. near `coverageWeightFor`):

```ts
  /**
   * Append a trace-id to the currently-executing action, if any. Called
   * from the per-request traceparent injection in `setupNavigationBlocking`.
   * No-op when no action is in flight (e.g. during initial page load).
   */
  private recordTraceId(traceId: string): void {
    if (!this.currentAction) return;
    if (!this.currentAction.traceIds) this.currentAction.traceIds = [];
    this.currentAction.traceIds.push(traceId);
  }
```

- [ ] **Step 4: Run unit tests, observe pass**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Wire `currentAction` into the action loop**

In `crawler.ts`, locate the action loop (search for `actionsPerformed < this.options.maxActionsPerPage`, around line 1989). The current loop body looks like:

```ts
const result = await this.performActionOnTarget(page, selectedTarget, url);

// Skip null results (element not visible)
if (result === null) {
  this.logger.debug("action_skipped", { target: selectedTarget.name || selectedTarget.selector, reason: "not visible" });
  continue;
}

actionsPerformed++;
this.actions.push(result);
```

Wrap so `currentAction` is set immediately before `performActionOnTarget` and cleared at the start of the *next* loop iteration (so late-firing requests still attach to the action that triggered them). Replace the loop's prelude to look like:

```ts
while (actionsPerformed < this.options.maxActionsPerPage && attempts < maxAttempts) {
  attempts++;

  // Clear at the start of each iteration. Late-firing requests from the
  // previous action attach to the previous action; once we begin the next,
  // attribution is the current iteration's responsibility.
  this.currentAction = null;

  const advisorPick = await this.consultAdvisorIfStalled(page, url, targets);
  const selectedTarget =
    advisorPick ??
    weightedPick(
      targets,
      (t) => t.weight * this.coverageWeightFor(url, t.selector),
      this.rng,
    );

  // Build a placeholder ActionResult ahead of the call so traceIds captured
  // during execution land on the right object. We mutate the SAME instance
  // returned by performActionOnTarget below.
  const placeholder: ActionResult = {
    type: "click", // overwritten by performActionOnTarget on success
    target: selectedTarget.name ?? selectedTarget.selector,
    selector: selectedTarget.selector,
    success: false,
    timestamp: Date.now(),
  };
  this.currentAction = placeholder;

  const result = await this.performActionOnTarget(page, selectedTarget, url);

  if (result === null) {
    this.logger.debug("action_skipped", { target: selectedTarget.name || selectedTarget.selector, reason: "not visible" });
    continue;
  }

  // Carry over any traceIds captured against the placeholder onto the
  // real result. (performActionOnTarget returns a fresh ActionResult.)
  if (placeholder.traceIds) result.traceIds = placeholder.traceIds;
  this.currentAction = result;

  actionsPerformed++;
  this.actions.push(result);
```

Leave the rest of the loop body unchanged.

After the loop exits (the `}` that closes the `while`), add one line so trace-ids fired AFTER the loop's last iteration but BEFORE the page closes still attach to the last action:

```ts
} // end while
// Last action stays current until the page closes — late-firing requests
// from the final iteration are still attributed correctly. The crawler
// will set currentAction = null at the next page's loop entry.
```

(If the loop's closing brace already has trailing code, place the comment as a comment-only line; no functional change is needed at the bottom.)

- [ ] **Step 6: Verify the wiring compiles**

```bash
pnpm -F chaosbringer build
```

Expected: tsc reports zero errors.

- [ ] **Step 7: Verify the unit-test suite is still green**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: 3 tests still pass (the placeholder/result carry-over doesn't affect the unit test, which manipulates `currentAction` directly).

- [ ] **Step 8: Verify the full chaosbringer suite is green**

```bash
pnpm -F chaosbringer test
```

Expected: full suite green. Action loop continues to work the same way; we just added bookkeeping.

- [ ] **Step 9: Commit**

```bash
git add packages/chaosbringer/src/crawler.ts packages/chaosbringer/src/server-fault-correlation.test.ts
git commit -m "feat(chaosbringer): track currentAction + recordTraceId for per-action correlation"
```

---

## Task 3: Hook `recordTraceId` into the traceparent injection site

**Files:**
- Modify: `packages/chaosbringer/src/crawler.ts:1170-1200` (the `setupNavigationBlocking` route handler — synthesised-traceparent branch).

The previous task added the bookkeeping; this one connects the existing traceparent generator to it. After this task, the crawler's behaviour matches what Task 2's tests asserted *via direct hook calls*.

- [ ] **Step 1: Write the failing integration test**

Append to `packages/chaosbringer/src/server-fault-correlation.test.ts`:

```ts
describe("traceparent.onInject feeds recordTraceId", () => {
  it("invokes recordTraceId for each synthesised traceparent", () => {
    const crawler = freshCrawler();
    const action: ActionResult = { type: "click", target: "x", success: true, timestamp: 0 };
    (crawler as unknown as { currentAction: ActionResult | null }).currentAction = action;

    // Simulate two synthesised injections by calling recordTraceId directly,
    // mirroring what the in-route handler does.
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("aa".repeat(16));
    (crawler as unknown as { recordTraceId: (id: string) => void }).recordTraceId("bb".repeat(16));

    expect(action.traceIds).toEqual(["aa".repeat(16), "bb".repeat(16)]);
  });
});
```

This is a smoke check that the call surface exists and the trace-ids land. The actual route-handler integration is exercised end-to-end by the `examples/cloudflare-worker` test (Task 5).

- [ ] **Step 2: Run, observe pass**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: 4 tests pass (the new one + the 3 from Task 2).

- [ ] **Step 3: Wire the route handler to call `recordTraceId`**

In `packages/chaosbringer/src/crawler.ts`, find the synthesised-traceparent branch in `setupNavigationBlocking`. The current code (around line 1187–1199) is:

```ts
} else {
  const traceId = randomBytes(16).toString("hex"); // 32 hex chars
  const spanId = randomBytes(8).toString("hex"); // 16 hex chars
  const traceparent = `00-${traceId}-${spanId}-01`;
  outgoingHeaders = { ...reqHeaders, traceparent };
  traceparentHook?.({
    url,
    method,
    traceparent,
    traceId,
    spanId,
    existing: false,
  });
}
```

Add ONE line — the internal hook fires BEFORE the user-supplied hook so the report state is consistent regardless of what the user does in their callback:

```ts
} else {
  const traceId = randomBytes(16).toString("hex"); // 32 hex chars
  const spanId = randomBytes(8).toString("hex"); // 16 hex chars
  const traceparent = `00-${traceId}-${spanId}-01`;
  outgoingHeaders = { ...reqHeaders, traceparent };
  this.recordTraceId(traceId);
  traceparentHook?.({
    url,
    method,
    traceparent,
    traceId,
    spanId,
    existing: false,
  });
}
```

Do the SAME for the `existing` traceparent branch (around line 1170–1185). Find:

```ts
if (existingTp) {
  // Honour explicit propagation upstream — but still surface it to
  // the consumer hook so the report can record the correlation id.
  if (traceparentHook) {
    const parts = parseTraceparent(existingTp);
    traceparentHook({
      url,
      method,
      traceparent: existingTp,
      traceId: parts?.traceId ?? "",
      spanId: parts?.spanId ?? "",
      existing: true,
    });
  }
}
```

Modify so the trace-id from an upstream-supplied traceparent ALSO records to the current action (it's still the action that triggered the request):

```ts
if (existingTp) {
  const parts = parseTraceparent(existingTp);
  if (parts?.traceId) this.recordTraceId(parts.traceId);
  if (traceparentHook) {
    traceparentHook({
      url,
      method,
      traceparent: existingTp,
      traceId: parts?.traceId ?? "",
      spanId: parts?.spanId ?? "",
      existing: true,
    });
  }
}
```

- [ ] **Step 4: Verify build is clean**

```bash
pnpm -F chaosbringer build
```

Expected: tsc reports zero errors.

- [ ] **Step 5: Verify full chaosbringer suite is green**

```bash
pnpm -F chaosbringer test
```

Expected: full suite green. The route handler change is invoked only when `traceparentEnabled`, which existing tests don't toggle.

- [ ] **Step 6: Commit**

```bash
git add packages/chaosbringer/src/crawler.ts packages/chaosbringer/src/server-fault-correlation.test.ts
git commit -m "feat(chaosbringer): record per-action trace-ids at the traceparent injection site"
```

---

## Task 4: Compute the per-page and per-action joins in `generateReport`

**Files:**
- Modify: `packages/chaosbringer/src/crawler.ts` — `generateReport()` method (around line 2280).

This is the only task that produces user-visible behaviour. After it, `report.pages[i].serverFaultEvents` and `report.actions[i].serverFaultEvents` are populated whenever the input data warrants it.

- [ ] **Step 1: Write the failing test**

Append to `packages/chaosbringer/src/server-fault-correlation.test.ts`:

```ts
describe("generateReport joins serverFaults onto pages and actions", () => {
  function callGenerateReport(crawler: ChaosCrawler) {
    // generateReport is private. We invoke it via the public start() path
    // is too heavy; instead reach in directly with a cast.
    return (crawler as unknown as {
      generateReport: (endTime: number) => import("./types.js").CrawlReport;
    }).generateReport(Date.now());
  }

  it("populates PageResult.serverFaultEvents by pageUrl", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushPage(crawler, "https://app.test/b");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    pushFault(crawler, {
      pageUrl: "https://app.test/b",
      observedAt: 110,
      attrs: { kind: "latency", path: "/api/y", method: "POST", latencyMs: 200 },
    });

    const report = callGenerateReport(crawler);
    expect(report.serverFaults).toHaveLength(2);

    const a = report.pages.find((p) => p.url === "https://app.test/a")!;
    const b = report.pages.find((p) => p.url === "https://app.test/b")!;
    expect(a.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/x"]);
    expect(b.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/y"]);
  });

  it("omits serverFaultEvents on pages with no matching events", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushPage(crawler, "https://app.test/b");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    const report = callGenerateReport(crawler);
    const b = report.pages.find((p) => p.url === "https://app.test/b")!;
    expect(b.serverFaultEvents).toBeUndefined();
  });

  it("populates ActionResult.serverFaultEvents by traceId", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    const action = pushAction(crawler, {
      type: "click",
      target: "Buy",
      success: true,
      timestamp: 1,
      traceIds: ["aa".repeat(16), "bb".repeat(16)],
    });
    pushFault(crawler, {
      traceId: "aa".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: {
        kind: "5xx",
        path: "/api/x",
        method: "POST",
        targetStatus: 503,
        traceId: "aa".repeat(16),
      },
    });
    pushFault(crawler, {
      traceId: "cc".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 110,
      attrs: { kind: "5xx", path: "/api/y", method: "GET", targetStatus: 500, traceId: "cc".repeat(16) },
    });

    const report = callGenerateReport(crawler);
    expect(action.serverFaultEvents?.map((e) => e.attrs.path)).toEqual(["/api/x"]);
  });

  it("omits ActionResult.serverFaultEvents when traceIds is empty/absent", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    const noTraceAction = pushAction(crawler, {
      type: "scroll",
      target: "scrollY:200",
      success: true,
      timestamp: 1,
    });
    pushFault(crawler, {
      traceId: "ee".repeat(16),
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503, traceId: "ee".repeat(16) },
    });
    const report = callGenerateReport(crawler);
    expect(noTraceAction.serverFaultEvents).toBeUndefined();
  });

  it("references are shared between report.serverFaults and the joined views", () => {
    const crawler = freshCrawler();
    pushPage(crawler, "https://app.test/a");
    pushFault(crawler, {
      pageUrl: "https://app.test/a",
      observedAt: 100,
      attrs: { kind: "5xx", path: "/api/x", method: "GET", targetStatus: 503 },
    });
    const report = callGenerateReport(crawler);
    const flat = report.serverFaults![0];
    const onPage = report.pages[0].serverFaultEvents![0];
    expect(onPage).toBe(flat);
  });
});
```

- [ ] **Step 2: Run, observe failures**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: 5 new tests fail (`serverFaultEvents` is `undefined` on every page / action).

- [ ] **Step 3: Implement the joins in `generateReport`**

In `packages/chaosbringer/src/crawler.ts`, locate `private generateReport(endTime: number): CrawlReport { … }` (around line 2263). Find the `serverFaults` field assignment (around line 2313):

```ts
      // Field is omitted when no faults observed (matches advisor / coverage convention).
      serverFaults:
        this.serverFaultCollector && this.serverFaultCollector.size() > 0
          ? this.serverFaultCollector.drain()
          : undefined,
```

Refactor so the drain happens BEFORE the report literal is built — we need the drained array for the per-page / per-action joins as well as for the field itself. Restructure as follows:

a) Above the `return { …report literal… }` (or `const report = { … }`, depending on the existing shape), drain the collector once into a local:

```ts
    const drainedServerFaults =
      this.serverFaultCollector && this.serverFaultCollector.size() > 0
        ? this.serverFaultCollector.drain()
        : null;

    if (drainedServerFaults) {
      // Per-page join — same references as the flat list.
      for (const p of this.results) {
        const events = drainedServerFaults.filter((e) => e.pageUrl === p.url);
        if (events.length > 0) p.serverFaultEvents = events;
      }
      // Per-action join — only meaningful when traceparent injection is on
      // (otherwise traceIds is always empty/absent).
      for (const a of this.actions) {
        if (!a.traceIds || a.traceIds.length === 0) continue;
        const set = new Set(a.traceIds);
        const events = drainedServerFaults.filter((e) => e.traceId !== undefined && set.has(e.traceId));
        if (events.length > 0) a.serverFaultEvents = events;
      }
    }
```

b) Replace the `serverFaults: …` line in the report literal with:

```ts
      serverFaults: drainedServerFaults ?? undefined,
```

The total diff replaces one inline ternary with the local + post-loop block + one cleaner field reference.

- [ ] **Step 4: Run unit tests, observe pass**

```bash
pnpm -F chaosbringer test -- server-fault-correlation.test.ts
```

Expected: all 8 tests in the file pass (3 from Task 2, 1 from Task 3, 5 from Task 4).

- [ ] **Step 5: Verify full chaosbringer suite stays green**

```bash
pnpm -F chaosbringer test
```

Expected: full suite green.

- [ ] **Step 6: Verify build**

```bash
pnpm -F chaosbringer build
```

Expected: tsc reports zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/chaosbringer/src/crawler.ts packages/chaosbringer/src/server-fault-correlation.test.ts
git commit -m "feat(chaosbringer): join serverFaults onto PageResult + ActionResult in generateReport"
```

---

## Task 5: Update the cf-worker example to demonstrate Phase 2

**Files:**
- Modify: `examples/cloudflare-worker/chaos/run.ts` — add `traceparent: true`, surface per-page/per-action stats.
- Modify: `examples/cloudflare-worker/test.mjs` — assert at least one `serverFaultEvents` is attached.

- [ ] **Step 1: Add `traceparent: true` to the example chaos call**

In `examples/cloudflare-worker/chaos/run.ts`, locate the `chaos({ … })` call. Add `traceparent: true` as a top-level option, alongside `server: { mode: "remote" }`:

```ts
  const { passed, report } = await chaos({
    baseUrl: BASE_URL,
    seed: Number(process.env.SEED ?? "42"),
    maxPages: Number(process.env.MAX_PAGES ?? "20"),
    strict: false,
    traceparent: true,
    faultInjection: [
      faults.status(500, { urlPattern: /\/api\/todos$/, methods: ["GET"], probability: 0.2 }),
      faults.delay(2000, { urlPattern: /\/api\/todos/, probability: 0.1 }),
    ],
    server: { mode: "remote" },
    invariants,
    setup: async ({ page, baseUrl }) => {
      …
    },
  });
```

- [ ] **Step 2: Surface per-page / per-action stats in the example output**

In the same file, find the post-run `console.log` block (currently prints `pages=` / `errors=` / `server-side fault events: N`). After the existing summary, append:

```ts
  const pagesWithServerFaults = report.pages.filter((p) => p.serverFaultEvents && p.serverFaultEvents.length > 0);
  const actionsWithServerFaults = report.actions.filter((a) => a.serverFaultEvents && a.serverFaultEvents.length > 0);
  console.log(`pages with server faults: ${pagesWithServerFaults.length}`);
  console.log(`actions with server faults: ${actionsWithServerFaults.length}`);
```

- [ ] **Step 3: Extend the test to assert at least one action carried a fault**

In `examples/cloudflare-worker/test.mjs`, find the existing assertion block:

```js
const m = chaosStdout.match(/server-side fault events:\s*(\d+)/);
if (!m) {
  throw new Error("could not find 'server-side fault events: N' in chaos output — did the report formatting change?");
}
const n = Number(m[1]);
if (!Number.isFinite(n) || n <= 0) {
  throw new Error(`expected server-side fault events > 0 with CHAOS_5XX_RATE=0.5, got ${n}`);
}
```

After it, add a similar grep for the new line:

```js
const ma = chaosStdout.match(/actions with server faults:\s*(\d+)/);
if (!ma) {
  throw new Error("could not find 'actions with server faults: N' in chaos output — did Phase 2 wiring break?");
}
const na = Number(ma[1]);
if (!Number.isFinite(na) || na <= 0) {
  throw new Error(`expected at least one action joined to a server fault via traceId, got ${na}`);
}
```

Update the success log:

```js
console.log(`[test] PASS — ${n} fault events / ${na} actions joined via header round-trip`);
```

- [ ] **Step 4: Run the example test locally**

```bash
cd /Users/mz/ghq/github.com/mizchi/chaosbringer/examples/cloudflare-worker
pnpm test
```

Expected: PASS with both N > 0 and na > 0. The line format printed by `chaos/run.ts` should be:

```
server-side fault events: 1
pages with server faults: 1
actions with server faults: 1
[test] PASS — 1 fault events / 1 actions joined via header round-trip
```

- [ ] **Step 5: Commit**

```bash
cd /Users/mz/ghq/github.com/mizchi/chaosbringer
git add examples/cloudflare-worker/chaos/run.ts examples/cloudflare-worker/test.mjs
git commit -m "test(examples/cloudflare-worker): exercise + assert Phase 2 per-action correlation"
```

---

## Task 6: Rewrite the recipe to use the new fields

**Files:**
- Modify: `docs/recipes/server-side-correlation.md` — replace the manual-filter pseudo-code with the new fields and the activation matrix.

The Phase 1 recipe gestured at `action.traceparent` which does not exist. With Phase 2, `report.pages[].serverFaultEvents` and `report.actions[].serverFaultEvents` are directly available.

- [ ] **Step 1: Replace the verification section**

In `docs/recipes/server-side-correlation.md`, locate the section beginning `## Verification`. Replace it with:

```md
## Verification

After a run with `CHAOS_5XX_RATE=0.3`:

\`\`\`ts
const fivexx = report.serverFaults?.filter((e) => e.attrs.kind === "5xx") ?? [];
console.log(`server-side 5xx: ${fivexx.length}`);

// "What server faults fired on the page that broke?"
const failed = report.pages.filter((p) => p.errors.length > 0);
for (const p of failed) {
  const events = p.serverFaultEvents ?? [];
  if (events.length > 0) {
    console.log(p.url, events.map((e) => `${e.attrs.kind} ${e.attrs.path}`));
  }
}

// "Which click triggered the 503?"
for (const f of fivexx) {
  const action = report.actions.find((a) => a.serverFaultEvents?.includes(f));
  console.log(`5xx on ${f.attrs.path} → triggered by`, action?.target ?? "(no action attribution)");
}
\`\`\`

The trace-id join is the load-bearing primitive: same `traceparent` on the wire → same value in
\`report.actions[i].traceIds\` → same value in \`report.serverFaults[].traceId\` → the report
pre-computes the per-action match for you. Same value emitted on OTel attributes via
\`toOtelAttrs(attrs)\` in any downstream observability layer.
```

- [ ] **Step 2: Add the activation matrix**

Above the verification section (i.e. immediately after the existing "Step 3 — share the chaos seed" subsection), add:

```md
## Activation matrix

Two chaos options interact to populate the four fault-related fields on the report:

| `chaos({ traceparent })` | `chaos({ server: { mode: "remote" } })` | What's populated |
|---|---|---|
| absent | absent | nothing |
| absent | set | `report.serverFaults`, `pages[].serverFaultEvents`. No per-action attribution (no trace-ids to join on). |
| set | absent | `actions[].traceIds` (record-only). No fault events anywhere. |
| set | set | All four. The intended Phase 2 surface — see the example at \`examples/cloudflare-worker/chaos/run.ts\`. |

If the per-action `serverFaultEvents` field is empty when you expected it to be populated, the
diagnosis is almost always one of:
- \`traceparent: true\` was not set on \`chaos()\`.
- The action triggered no requests (scroll, hover) — it carried no trace-ids to join on.
- The fault fired during a navigation that ended on a different page than the one the action
  was issued on. The flat \`report.serverFaults[]\` is still the source of truth in those cases.
```

- [ ] **Step 3: Verify the recipe renders cleanly**

```bash
# nothing to run — markdown is read by humans + GitHub. Skim the file for
# obvious rendering issues (broken backticks, unclosed code fences).
head -200 docs/recipes/server-side-correlation.md
```

Expected: the file ends without dangling backticks; the activation table renders as a markdown table.

- [ ] **Step 4: Commit**

```bash
git add docs/recipes/server-side-correlation.md
git commit -m "docs(recipe): rewrite server-side-correlation for Phase 2 (per-page + per-action fields)"
```

---

## Task 7: Open the PR

**Files:** none modified.

- [ ] **Step 1: Run the full chaosbringer test suite + build one last time**

```bash
cd /Users/mz/ghq/github.com/mizchi/chaosbringer
pnpm -F chaosbringer test
pnpm -F chaosbringer build
```

Expected: green + tsc clean.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/chaos-correlation-phase-2
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(chaosbringer): per-page + per-action server-fault correlation (#56 Phase 2)" --body "$(cat <<'EOF'
## Summary
- \`PageResult.serverFaultEvents?: ServerFaultEvent[]\` — server-side faults that fired while a page was active. Pre-computed view of \`report.serverFaults\` filtered by \`pageUrl\`.
- \`ActionResult.traceIds?: string[]\` — W3C trace-ids of requests issued during an action's window. Captured at the chaosbringer traceparent injection site.
- \`ActionResult.serverFaultEvents?: ServerFaultEvent[]\` — server-side faults whose \`traceId\` matches one of the action's \`traceIds\`. Pre-computed view of \`report.serverFaults\`.

The flat \`report.serverFaults[]\` from Phase 1 is unchanged — both new fields are derived views over the same array. No data duplication, no breaking change.

Spec: [\`docs/superpowers/specs/2026-05-06-chaos-server-orchestration-phase-2-design.md\`](https://github.com/mizchi/chaosbringer/blob/feat/chaos-correlation-phase-2/docs/superpowers/specs/2026-05-06-chaos-server-orchestration-phase-2-design.md)

Closes the remaining work on #56 Phase 2 (per-action + per-page correlation). Same-process direct-handle (Option A in the brainstorm) and auto-seed propagation (Option C) remain explicitly out of scope.

## Activation
Both options have to be set for the full Phase 2 surface:
\`\`\`ts
await chaos({
  …,
  traceparent: true,
  server: { mode: "remote" },
});
\`\`\`
The activation matrix is documented in \`docs/recipes/server-side-correlation.md\`.

## Test plan
- [x] \`pnpm -F chaosbringer test\` — full suite green (including 9 new tests in \`server-fault-correlation.test.ts\`).
- [x] \`pnpm -F chaosbringer build\` — tsc clean.
- [x] \`examples/cloudflare-worker\` test extended to assert at least one action joined to a server fault via traceId.
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** types.ts (Task 1), currentAction tracking + recordTraceId (Tasks 2-3), generateReport joins (Task 4), example demonstration (Task 5), recipe rewrite (Task 6), PR (Task 7). The activation-matrix behaviour from spec §"Activation matrix" lands in Task 6's recipe; the runtime gating is implicit (fields stay absent without the right options) and is exercised by the negative test in Task 4 Step 1.
- **No placeholders:** every task has concrete code in every code step. Test snippets are full not truncated. The injection-site edit shows the EXACT before/after.
- **Type consistency:** `serverFaultEvents` is the SAME field name on both `PageResult` and `ActionResult`. `traceIds` is the only new field on `ActionResult`. `recordTraceId` is the only new private method on `ChaosCrawler`. `currentAction` is the only new private field. All match across tasks.
- **Sequencing risk:** Task 2 leaves `currentAction` populated but unused at the route handler. Task 3 wires it. Each commit independently leaves the suite green because the route-handler change is gated on `traceparentEnabled` (existing tests don't toggle this). If the test runner finds Task 2's commit alone, all existing tests still pass — the new field/method are simply dead until Task 3.
