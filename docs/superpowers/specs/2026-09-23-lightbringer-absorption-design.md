# Absorbing lightbringer — Design

**Date:** 2026-09-23
**Project:** chaosbringer
**Status:** Proposal (no implementation in this PR)

**Goal:** Bring [mizchi/lightbringer](https://github.com/mizchi/lightbringer)'s per-step resource measurement (network / CPU / render / INP / frames / memory / media / coverage, split per span) into this repo, and wire it into the crawler so every page load and every action chaosbringer performs becomes a measured span.

**Why here:** lightbringer measures a scenario someone wrote by hand. chaosbringer already *generates* scenarios — BFS crawl, weighted and AI drivers, recorded traces, Quint fault plans, the load runner. Once measurement is attached to that, the crawler finds the slow step itself, measures it under injected faults, and gates on it in CI. lightbringer cannot do any of that on its own.

**Non-goals:** a general always-on profiler; heap-snapshot retained-graph analysis. lightbringer already excludes both. Also out of scope: Firefox/WebKit perf, since the whole layer is CDP.

**Out of scope (this PR):** implementation. This PR ships the contract, the package boundary and the phased plan (§9).

---

## 1. What exists today

### chaosbringer

- `collectMetrics` (`packages/chaosbringer/src/crawler.ts:1799`) makes one `page.evaluate` after load and reads TTFB / DCL / load / FCP from Navigation and Paint Timing.
- **Bug:** `PerformanceMetrics.lcp` / `.tbt`, `PERF_BUDGET_KEYS` (`types.ts:475-519`) and `--budget lcp=…` are declared, but nothing ever measures LCP or TBT. Those budgets can never fire, and `summary.avgMetrics.lcp` is always 0. The README advertises budgets for all four metrics.
- The crawler opens CDP sessions in three separate places:
  - network profile (`crawler.ts:1274`);
  - V8 coverage (`crawler.ts:1392`);
  - the lifecycle-fault executor's lazy `getCdp()` (`packages/playwright-faults/src/lifecycle-faults.ts:177`).
- The step loop settles with hard-coded waits:
  - `goto(..., { waitUntil: "networkidle" })` (`crawler.ts:1458`, `:1668`);
  - `waitForLoadState("networkidle", { timeout: 2000 })` after every click (`:2394`);
  - `waitForTimeout(100)` after every step, in all three action loops (`:1944`, `:2158`, `:2254`).
- Wall-clock-only timing lives in the load runner (`src/load/`: per-response latency, p50/p95/p99, SLO gating) and in `journey` / `parity` / `replay`.
- `playwright-v8-coverage` shows the pattern for extracting a CDP collector into its own workspace package.

### lightbringer (about 3.6k lines of `src/`)

It splits cleanly into layers:

| Layer | Files | Coupling |
|---|---|---|
| Pure analysis | `analyze/{network,render,memory,coverage,vitals,util}.ts` (about 1.3k lines) | none |
| Session core | `browser.ts` (in-page collector), `capture.ts` (Network + Tracing), `controller.ts` (`measure`/`measureRepeat`), `session.ts` (`startSession(page, cdp)`), `report.ts`, `report-types.ts`, `trace.ts`/`otel.ts` (app spans) | `playwright` types + a `CDPSession` |
| Runner edges | `fixture.ts`, `auto.ts`/`autowrap.ts`, `cli.ts`, `scripts/{median,regress,drilldown,coverage}.mjs`, the Node loader shim | `@playwright/test`, env, fs |

Three properties matter for porting:

1. `config.ts` reads `PERF_*` env vars and the filesystem at **import time**, and `session`/`controller` default from it.
2. `window.__perf` is read **once**, in `finish()`, from the final document. The init script recreates it on every navigation, so after a `goto` the earlier documents' long tasks, frames, events and vitals are gone. Only CDP-side data (Network, `getMetrics`) survives navigations.
3. Tests are in-source (`if (import.meta.vitest)`). This repo uses sibling `*.test.ts` / `*.e2e.test.ts` files.

---

## 2. Package boundary

```
packages/
├── playwright-perf/            # NEW — @mizchi/playwright-perf (lightbringer core, runner-agnostic)
│   └── src/
│       ├── analyze/            # ported as-is (pure) + sibling tests
│       ├── collector.ts        # was browser.ts — in-page init script
│       ├── capture.ts          # Network + Tracing capture
│       ├── session.ts          # PerfSession: open/close spans on a Page + CDPSession
│       ├── report.ts / report-types.ts / summary.ts
│       ├── budget.ts           # checkBudgets, emitBudgets(median×headroom), median/IQR, regress
│       ├── app-spans.ts        # was trace.ts + otel.ts (performance.measure spans)
│       └── index.ts
├── playwright-perf/fixture     # subpath export: lightbringer's `test`/`perf` fixture + `auto`
└── chaosbringer/
    └── src/
        ├── page-cdp.ts         # NEW — one shared CDPSession per page (see §4)
        ├── perf.ts             # NEW — crawler ⇄ PerfSession glue, span naming, fault tagging
        ├── settle.ts           # NEW — adaptive settle (Phase 3, §6.1)
        └── crawler.ts / types.ts / budget.ts / reporter.ts / cli.ts   # MODIFY
```

**Why a separate package rather than `chaosbringer/src/perf/`:** this is the same reason `playwright-v8-coverage` and `playwright-faults` are separate. The measurement core is useful without the crawler, which is lightbringer's entire user base. It has one dependency that chaosbringer doesn't need (`web-vitals`), and it gets its own release-please line. chaosbringer depends on it via `workspace:*`.

**The lightbringer repo afterwards** (see §9, Phase 4):
- `lightbringer` becomes a thin package re-exporting `@mizchi/playwright-perf` and `@mizchi/playwright-perf/fixture`, keeping its bin names, and is marked deprecated in its README.
- The JSON-scenario CLI moves to `chaosbringer perf run scenario.json`.
- The spec-mode CLI (the loader shim) moves along with the fixture.

---

## 3. Core refactors while porting (Phase 0)

These refactors are why this is a port rather than a copy.

### 3.1 Configuration is an argument, not an import side effect

```ts
export interface PerfOptions {
  /** Default "light". "trace" adds Tracing (paint/GPU/CPU samples, drilldown). */
  level?: "light" | "trace";
  memory?: { forceGc?: boolean };                  // was PERF_MEM
  coverage?: boolean;                              // was PERF_COV
  cssSelectorStats?: boolean;                      // was PERF_CSS (implies level: "trace")
  settleTimeoutMs?: number;                        // was PERF_SETTLE_TIMEOUT
  tracePath?: string;                              // where to stream the trace when level: "trace"
  /** Clock the collector trusts; see §3.3. */
}
export function perfOptionsFromEnv(env = process.env): PerfOptions; // only the fixture/CLI edges call this
```

CPU and network throttling are **not** `PerfOptions`. chaosbringer already owns them: `faults.cpu()` is a lifecycle fault and `applyNetworkProfile` handles the network. The fixture edge maps `PERF_CPU` / `PERF_NET` onto those same primitives, so lightbringer's duplicate network-profile table goes away.

The web-vitals IIFE is resolved lazily, on first `startPerfSession`, and cached.

### 3.2 Drain per span, not once per document

`PerfSession.endSpan()` calls `__perf.flush()` and **moves** the drained entries into node-side span state. It does this *before* returning, so a later navigation cannot destroy them. `timeOrigin` is re-read per document; the collector posts it on init and the session keys entries by document. This fixes lightbringer's multi-navigation loss. It is also a hard requirement here: the crawler navigates constantly, and SPA route changes are exactly the steps we want to measure.

### 3.3 Immunity to runtime faults

`runtime-faults`' `clock-skew` patches `performance.now` / `Date`, and the collector reads both.
- The collector init script is installed **first**, before the runtime-fault init script (context-level ordering in `crawler.ts` `start()`).
- It captures the unpatched `performance.now` and `performance.timeOrigin` into a closure.
- Node-side windows use CDP `Performance.getMetrics` `Timestamp` (monotonic) plus `Network` `wallTime`. Neither can be skewed from page JS.
- A span measured while clock-skew is active is tagged (`faults: ["clock-skew"]`, see §5.3), so no one reads its in-page durations as ground truth.

### 3.4 Test layout

Each in-source `import.meta.vitest` block becomes a sibling `*.test.ts`. Browser tests become `*.e2e.test.ts` against a static fixture, following the pattern of `driver-geometry.e2e.test.ts`. lightbringer's `examples/accuracy.spec.ts` claims (±1 ms `scriptMs`, exact `blockingMs`) become an e2e test so the accuracy table stays true after the port.

---

## 4. Shared per-page CDP session

```ts
// packages/chaosbringer/src/page-cdp.ts
export interface PageCdp {
  /** Lazily opened, one per Page, closed with the page. */
  session(): Promise<CDPSession>;
  /** Idempotent domain enable; callers never double-enable Network/Performance. */
  enable(domain: "Network" | "Performance" | "Profiler" | "Tracing"): Promise<void>;
}
export function pageCdp(context: BrowserContext, page: Page): PageCdp; // WeakMap<Page, PageCdp>
```

The network profile, `CoverageCollector`, the lifecycle executor's `getCdp()` and `PerfSession` all take a `PageCdp`, or the `CDPSession` it yields. `playwright-faults` keeps its current lazy `getCdp()` signature as the fallback when no session is injected, so it stays usable standalone.

This removes up to three redundant session attaches per page. It also avoids duplicate `Network.enable` calls, which double event traffic.

---

## 5. Crawler integration (Phase 1–2)

### 5.1 Option

```ts
interface ChaosCrawlerOptions {
  /** Off by default. `true` ≡ { level: "light" }. */
  perf?: boolean | PerfOptions & {
    /** Measure actions too (default true). false = page-load spans only. */
    actions?: boolean;
  };
}
```

With `perf` unset, behaviour and overhead are exactly as today, except for the LCP/TBT fix in §5.4. That fix is cheap enough to always run.

### 5.2 Span model

| Span | Opens | Closes | Name |
|---|---|---|---|
| `load` | before `page.goto` in `crawlPageWithExistingPage` | after `afterLoad` invariants (today's `collectMetrics` point) | `load <path>` |
| `action` | before `performActionOnTarget` | after that action's settle | `<type> <selector ?? target>` |
| `app` | page code calls `startSpan`/`withSpan` (lightbringer `trace.ts`) | same | user-supplied |

`load` + `action` spans cover all three action loops (weighted, driver, replay). They open and close at the same points where `currentAction` is set today, so a span and the `traceIds` the action already collects describe the same interval.

**Stable span key.** Budgets and baselines need a key that stays the same from one run to the next. `perfKey = urlPattern(page) + " :: " + type + " " + selector`:
- `urlPattern` reuses the URL normalisation the heatmap/diff already group by.
- `selector` is the one `ActionResult.selector` already records; `target` is the fallback when there is no selector.
- Random fill values never enter the key, per the `ActionResult.value` rationale.

### 5.3 Result shape

```ts
interface PageResult   { /* … */ perf?: SpanReport; }        // the load span
interface ActionResult { /* … */ perf?: SpanReport; }        // this action's span
interface SpanReport   { /* lightbringer SpanReport, plus: */
  key: string;                       // perfKey, §5.2
  faults?: string[];                 // fault rules / lifecycle / runtime faults active in-window
}
interface CrawlReport  { /* … */ perf?: CrawlPerfSummary; }
interface CrawlPerfSummary {
  vitals: Record<string, { p50: number; p75: number; worst: { value: number; url: string } }>;
  slowestActions: { key: string; durationMs: number; blockingMs: number; interactionMs?: number }[];
  hotInitiators: { frame: string; requestCount: number; encodedKB: number }[]; // across the crawl
  thirdParty: { domain: string; requestCount: number; encodedKB: number; busyMs: number }[];
  trends?: Trend[];                  // repeated keys across the crawl → leak signal for free
  coverage?: CoverageReport;         // union over every page, when coverage: true
}
```

The **`faults` tag** records which faults were active during the span. It is what makes perf-under-chaos readable (§6.2). It comes from what the crawler already records for the interval: fault-rule firings, lifecycle stage, runtime faults and server-fault events joined by `traceIds`.

Following #145's rule, fields that were not measured are **absent**, never 0. `interaction` and `frames` stay optional exactly as in lightbringer.

### 5.4 Replace `collectMetrics` (the LCP/TBT fix)

- `PerformanceMetrics` is filled from the collector: `lcp` from web-vitals, and `tbt` = Σ(longTask − 50 ms) inside the `load` span. `ttfb`, `fcp`, `domContentLoaded` and `load` keep their current definitions.
- The collector init script alone, without Tracing or `getMetrics`, is enough for these five fields. It therefore runs even with `perf` unset.
- That closes the dead-budget bug, and the README claim becomes true.
- **Fallback:** the fixture path (`testPage()` on a caller-owned page, which may have navigated before the init script existed) keeps the current `page.evaluate` read for TTFB/FCP/DCL/load. It leaves `lcp`/`tbt` absent rather than 0.

### 5.5 Budgets

`PerformanceBudget` gains per-span keys from lightbringer's `BUDGET_METRIC`, scoped by `perfKey` glob:

```ts
perfBudgets?: {
  match: string;                         // glob over perfKey, e.g. "/cart* :: click *"
  budget: Partial<Record<BudgetMetric, number>>; // durationMs, blockingMs, interactionMs, encodedKB, requestCount, layoutCount, droppedFrames, …
}[];
```

Violations reuse `checkPerformanceBudget`'s existing path: an `invariant-violation` error named `perf-budget.<metric>`. That means they already flow into JUnit, the reporter, error clusters and the PR gate with no new plumbing.

### 5.6 CLI

```
chaosbringer --url … --perf [--perf-trace] [--perf-mem] [--perf-cov]
chaosbringer perf run scenario.json            # lightbringer's JSON scenario CLI
chaosbringer perf emit-budgets <reports…>      # median × 1.25 per perfKey → chaosbringer.perf-budgets.json
chaosbringer perf gate <reports…>              # median/IQR gate; noisy metrics warn
chaosbringer perf regress <baseline> <current> # lightbringer regress.mjs, threshold 0.15 + abs floors
chaosbringer perf drilldown <report> <key>     # trace drilldown (level: "trace")
```

- `emit-budgets` / `gate` / `regress` read `CrawlReport`s. Repeats come from running the crawl N times with a fixed seed, or from `shard` + `mergeReports`, which already exists.
- lightbringer's `<slug>.run<N>.json` filename convention is dropped. Reports carry their own seed and run index.
- `regress` fits the existing `chaos-baseline` workflow: baseline artefact vs PR run.

---

## 6. What the absorption unlocks

These are the reasons to do this here rather than keep two tools, grouped by what gets faster.

### 6.1 The crawler itself gets faster: adaptive settle (Phase 3)

Every step currently pays `networkidle` (a 500 ms idle window, capped at 2 s after clicks) plus a fixed 100 ms. With the collector and the shared CDP session, the crawler knows directly whether the page has settled:
- in-flight request count, from CDP Network;
- rAF cadence;
- long tasks.

```ts
settle: "adaptive" | "networkidle" /* today */ | number
// adaptive: resolve when inflight == 0 for Q ms AND no long task for Q ms AND ≥ 2 rAFs,
//           capped at the old timeout. Q defaults to the TimingProfile's measured quiesce.
```

- `timing.ts` already solves settle/quiesce from a calibrated `TimingProfile`. Adaptive settle is the runtime counterpart of that solver, and `model calibrate` can seed Q from measured spans instead of wall-clock probes.
- **Expected effect:** on a static page, the per-step floor drops from roughly 600 ms to roughly one or two frames.
- **Safety:** `capped` is recorded on the span. A step that hits the cap is exactly the "never quiesces" finding the model-fault oracles care about, so it becomes a signal instead of a silent 2 s.
- **Rollout:** stays opt-in until an e2e compares crawl results (same seed, same set of visited pages, same errors) between `networkidle` and `adaptive`.

### 6.2 The app gets faster: perf under chaos

A span tagged with `faults` next to the same `perfKey` without faults gives the **degradation delta** of a step under a fault. Examples:
- a 503 on `/api/cart` makes `click Add` cost 4× the requests (a retry storm);
- a 300 ms delay makes the spinner drop 40 frames.

The load runner's `amplification` oracle and `server-fault-correlation` already count retries. This adds their user-visible cost (INP, blocking, frames) at the same join key (`traceIds`). The report gains `perf.degradation[]`, the top-N `(perfKey, fault)` pairs by delta.

### 6.3 The app gets faster: coverage-scale measurement

- lightbringer's `coverage.mjs` unions chunk coverage over *hand-written* scenarios.
- A crawl reaches pages and actions nobody wrote a spec for, so the "code no scenario touched" list becomes much more trustworthy.
- `playwright-v8-coverage` already runs `Profiler.takePreciseCoverage`. The perf layer's byte-range coverage and V8 function coverage share the `PageCdp` session instead of running twice.

### 6.4 Leak detection for free

lightbringer needs `measureRepeat` to see a monotonic climb. A crawl naturally repeats the same `perfKey` (the same nav click on every page). `buildTrends` over repeated keys flags listener, DOM-node or ArrayBuffer growth without extra runs.

### 6.5 Perf-seeking drivers (Phase 3)

This follows the #145 rule: facts the crawler already measured go to model seams, and they are lazy and absent-when-unmeasured.
- `DriverStep.lastActionPerf?: Pick<SpanReport, "durationMs" | "blockingMs" | "interaction" | "network">`
- `AdvisorContext.lastActionPerf?`, the same shape.

`perfSeekingDriver` weights candidates whose `perfKey` produced high `blockingMs` / `interactionMs` in earlier steps or runs. This is the perf counterpart of `coverageWeightFor`: it hunts for the slowest interaction instead of the newest code.

### 6.6 Load + perf

- Today, load-runner steps report wall-clock `durationMs` and per-response latency.
- With `perf: { level: "light" }` on one sampled worker, the SLO report shows how browser-side cost (blocking, INP) degrades as concurrency rises.
- `level: "trace"` stays off for load workers, because a trace per worker is too heavy.

---

## 7. Overhead and levels

| Level | Adds | Rough cost | Default |
|---|---|---|---|
| (always) | collector init script: web-vitals + observers + rAF probe | one script per document; the rAF loop is the only steady cost | on (feeds §5.4) |
| `light` | `Performance.getMetrics` ×2 per span; `Network.*` events via `PageCdp` | 2 CDP round-trips per span | `--perf` |
| `trace` | `Tracing` streamed to disk; paint/GPU/CPU samples; drilldown | large (tens of MB/page); only Paint/GPUTask kept in memory | `--perf-trace` |
| `memory.forceGc` | `HeapProfiler.collectGarbage` ×2 per span boundary | slow; changes timing | `--perf-mem` |
| `coverage` | JS/CSS coverage, `resetOnNavigation: false` | moderate | `--perf-cov` |

The "always" row is the one behaviour change for users who never pass `--perf`. It needs an e2e showing no crawl-result difference. If the rAF loop is measurable, it can be gated to run only inside open spans.

---

## 8. Risks and decisions

- **Chromium-only.** The crawler is already Chromium-only (`chromium.launch`), so this adds no new restriction. The fixture subpath must degrade to "absent" on other browsers, not throw.
- **Durations include harness overhead.** lightbringer's accuracy table puts `durationMs` 15–30 ms over. `perfKey` budgets derived from medians absorb this; the docs must say so.
- **SwiftShader GPU numbers are not real.** `gpuMs` is reported only when `level: "trace"` runs with real GPU flags. Otherwise it is absent.
- **`setContent` / pre-existing pages** skip init scripts. They get `collectorMissing: true` and absent fields, never zeros.
- **Report size.** Per-action `SpanReport` with up to 20 requests is large for a 500-page crawl. `CrawlReport.pages[].actions[].perf.network.requests` is capped at 5 in the crawl report, and full span detail goes to a sidecar `perf/*.json` alongside the HAR and trace artefacts.

---

## 9. Phased plan

| Phase | Deliverable | Done when |
|---|---|---|
| **0: extract** | `packages/playwright-perf`: `analyze/` ported with sibling tests; `PerfOptions` replaces import-time env; per-span drain (§3.2); clock-skew immunity (§3.3); fixture subpath; the accuracy e2e | lightbringer's example specs pass against the new package; the multi-navigation e2e keeps pre-navigation long tasks |
| **1: wire** | `PageCdp` (§4) adopted by network profile, coverage and lifecycle; `collectMetrics` replaced (§5.4, **fixes LCP/TBT**); `load`/`action` spans + `perf` on results; reporter lines; `--perf` flags | an e2e fixture page with a known 120 ms long task on click yields `blockingMs ≈ 70` on that action; an LCP budget fires |
| **2: gate** | `perfBudgets` (§5.5); `chaosbringer perf emit-budgets / gate / regress / drilldown / run`; `CrawlPerfSummary`; wired into the `chaos-baseline` / `chaos-pr-gate` workflows | the PR gate fails on an injected regression in the playground v2 |
| **3: exploit** | adaptive settle (§6.1); `faults` tag + degradation report (§6.2); crawl-wide coverage union and trends (§6.3–6.4); `lastActionPerf` + `perfSeekingDriver` (§6.5) | same-seed crawl parity between `networkidle` and `adaptive`, with measured wall-clock savings reported in the PR |
| **4: retire** | lightbringer repo → a deprecated re-export of `@mizchi/playwright-perf`; its docs guide moves to `docs/recipes/perf.md` | `npx lightbringer run` still works via the re-export |

Each phase is one PR, or a small PR stack, with its own release-please entry.

---

## 10. Open questions

1. **Package name.** `@mizchi/playwright-perf` (it matches the `playwright-*` siblings), or keep the `lightbringer` name inside this monorepo?
2. **lightbringer repo.** Thin re-export (proposed), or archive outright?
3. **Always-on collector (§5.4 / §7).** Is fixing LCP/TBT worth a default-on init script, or should the LCP/TBT budget keys require `--perf`?
4. **Adaptive settle default.** Keep it opt-in permanently, or flip the default after Phase 3's parity e2e?
