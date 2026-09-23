# lightbringer

Per-step resource measurement for Playwright scenarios.

**Responsibility:** lightbringer measures the resources a Playwright scenario
consumes — at its **initialization** (the initial load) and **between its steps**
(each interaction / transition) — so you can optimize that resource usage. It
breaks each step's cost into **network**, **CPU**, and **render** (plus web-vitals
including INP), so the only way to move a number is to change the implementation,
not how the test waits.

Lighthouse only measures the initial load; lightbringer covers the whole scenario
lifecycle, step by step.

> New here? The [reading guide](docs/guide.md) walks through measuring a scenario
> and reading a real, annotated report line by line — or jump straight to the
> runnable [sample project](examples/sample-project/) (`pnpm exec playwright test
> --config examples/sample-project/playwright.config.ts`).

**In scope:** per-step network / CPU / render / INP / memory load of one scenario,
a median gate for regressions, and a trace drilldown to the responsible code.
**Out of scope (non-goals):** a general always-on profiler, cross-scenario / whole-
suite analysis, and heap-snapshot leak analysis (the retained-object graph — which
object holds what). Memory is measured as a per-step *load* (heap / buffer / DOM /
listener gauges and their per-step delta), not as a retained-graph diff.

```
[perf] measure initial load and a follow-up navigation
  vitals  LCP=120 (good)  INP=48 (good)  CLS=0 (good)  TTFB=12 (good)
  initial-load                  210ms
      net   busy=160ms  18reqs  7waves  680KB
      cpu   block=52ms  longtasks=1  maxTask=52ms  loaf=1/0ms
      render style=7/4.5ms  layout=7/8.9ms  script=56ms  paint=8/1.7ms  gpu=6ms
      mem   heap=12.4MB (+2.1MB)  arraybufs=3  listeners=84 (+6)  docs=+0  domNodes=512
  app-work                       22ms
      ...
  app spans (performance.measure):
    demo-work 20ms  net=0ms/0KB  cpu=0ms
  total network 21 reqs / 681KB
```

## What it measures

Per **span** (one `perf.measure(name, action)` region):

- **web-vitals (attribution build)** — LCP / INP / CLS / TTFB / FCP with attribution.
  LCP is broken into its sub-parts (TTFB / resource load delay / load duration /
  **render delay**) so you can see whether it's server-, resource-, or render-bound,
  and `report.renderBlocking` lists the `<head>` stylesheets / parser-blocking
  scripts standing between navigation and first paint.
- **network** (CDP) — request count, transferred KB, `busyMs` (union of request
  intervals = how long the network was actually busy), and `waves` (approximate
  serial-dependency depth of the waterfall), and how many requests were served
  from cache (`fromCacheCount` — disk / memory / prefetch / SW, no network fetch).
  Each request also carries its
  **initiator** (the code or parser that issued it); `network.byInitiator` rolls
  them up so a deep waterfall points straight at the responsible function
  (`get  /App.tsx:244 (6)`) — the network-side analogue of the CPU drilldown.
- **third-party** — the slice of the network served from a registrable domain
  other than the page's: bytes the app didn't ship and network time it didn't
  ask for (analytics, tag managers, ad tech, embedded widgets), broken down per
  domain (`network.thirdParty`). CPU spent by third-party scripts is attributed
  by the drilldown, which classifies each CPU-profiler frame by its script URL.
- **cpu** — long task count, total blocking time, heaviest long task, LoAF.
- **interaction** (per-step INP) — the worst interaction *inside each span*, split
  into input delay / processing / presentation (Event Timing). web-vitals reports
  one page-global worst INP; this tells you which step was janky and why (e.g. a
  toggle whose 80 ms is almost all presentation = the repaint after it, not the
  handler). `interactionMs` is budgetable.
- **frames** (animation smoothness) — a rAF probe records frame cadence, so each
  span reports effective fps, dropped frames (gaps ≥ one 60 Hz frame), and the
  worst hitch (`longestFrameMs`). The render metrics say how much paint/GPU work;
  this says whether it rendered smoothly. `droppedFrames` / `longestFrameMs` are
  budgetable.
- **render** — style recalc / layout count and time (from CDP
  `Performance.getMetrics` cumulative counters), JS execution time; and, with
  `PERF_TRACE=1`, Paint count/time and **GPU task time** (`gpuMs`) from the trace.
  The drilldown rolls GPU work up per type (GPUTask / RasterTask / …) so a step
  that's cheap on the main thread but GPU-bound is visible. `recalcStyleMs` is the
  **CSS selector-match cost** of a step; the report's `css` profile (selectors ×
  DOM nodes) is the structural cause, and `PERF_CSS=1` + the drilldown name the
  individual costly / wasteful selectors.
- **memory** — per-step memory *load* from `Performance.getMetrics` gauges:
  on-heap JS used + delta (`jsHeapUsedMB` / `jsHeapDeltaMB`), live ArrayBuffer
  count, retained DOM nodes, event-listener count + delta, and document delta. A
  delta that stays positive across repeated runs of the same step is the leak
  signal. Counts (listeners / ArrayBuffers / documents) are the reliable signals;
  heap bytes are noisy unless you force a GC with **`PERF_MEM=1`** (which measures
  the deltas after `HeapProfiler.collectGarbage`, i.e. retained memory only). Note
  byte-level buffer / GPU memory is not observable via CDP — only the ArrayBuffer
  *count* is, so binary / GPU-staging memory shows as a climbing count, not bytes.
  Repeat a step with `perf.measureRepeat(name, action, { times })` and lightbringer
  reports whether memory climbs monotonically across the repeats (`report.trends`,
  flagged `⚠ likely leak`) — the reliable leak signal, since repeating averages out
  the single-step GC noise.

- **media** — image over-fetch (intrinsic px ≫ rendered px — a 1760×626 logo shown
  at 128×46 is 187× too big) and large resources shipped near-uncompressed
  (decoded ≈ encoded), from Resource Timing + the DOM. `report.media`.
- **coverage** (PERF_COV=1) — JS + CSS coverage across the whole scenario: how
  much of each downloaded chunk / stylesheet the run actually executed. Per-chunk
  `usedPct` flags chunks split too coarsely (low usage ⇒ lazy-load / drop
  candidate), and `scripts/coverage.mjs` unions the used byte ranges across every
  scenario to find code **no** scenario touched (dead code / over-shipping).

All times are unified to epoch ms so spans correlate with network / CPU even
across navigations.

## CLI (no install, no spec)

The fastest way to try it: no dependency to add, no test file to write. Describe
the scenario as JSON and run it with `npx` / `pnpm dlx`. Each step becomes one
measured span.

```jsonc
// scenario.json
{
  "url": "http://localhost:5173",
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    { "name": "initial-load", "goto": "/", "waitFor": "#app" },
    { "name": "open-cart", "click": "text=Cart", "waitFor": "[role=dialog]" },
    { "name": "pan", "drag": ".map", "by": [-240, -160] }
  ]
}
```

```sh
pnpm dlx lightbringer run scenario.json                 # measure, print the breakdown
pnpm dlx lightbringer run scenario.json --gpu --cov     # real GPU + chunk coverage
pnpm dlx lightbringer run scenario.json --repeat 5 --emit-budgets   # write budgets from the medians
pnpm dlx lightbringer run scenario.json --repeat 5 --gate           # fail if a median exceeds them
```

`--emit-budgets` derives `lightbringer.budgets.json` from the measured medians
(×1.25 headroom) — **you never hand-write a number** — and `--gate` fails the run
against it. Step fields: `goto`, `click`, `fill`+`text`, `press`, `drag`+`by`,
`waitFor`, `wait`, and a per-step `settle` (`networkidle` (default) / `load` /
`raf` / a number of ms). Flags: `--repeat N`, `--out DIR`, `--gpu`, `--cpu N`,
`--net slow-3g|fast-3g|4g`, `--cov`, `--mem`, `--css`, `--trace`, `--headed`.

The CLI bundles Playwright; the browser binary is the only prerequisite
(`npx playwright install chromium`). For CI integration or app-code spans, use the
test fixture below instead.

### Run an existing Playwright spec (reuse your specs + config)

Already have `e2e/*.spec.ts` and a `playwright.config.ts`? Point `run` at a spec
(anything that isn't `.json`) and lightbringer runs it through `playwright test`
with **your existing config** (webServer / baseURL / projects) — measuring every
navigation and interaction, **without editing the spec**:

```sh
pnpm dlx lightbringer run e2e/checkout.spec.ts
pnpm dlx lightbringer run e2e/ --config playwright.config.ts --repeat 5 --emit-budgets
```

It works by injecting a Node loader that swaps the spec's `@playwright/test` `test`
for the auto-instrumented one (the same as `lightbringer/auto`), so each
`page.goto` / `getByRole(...).click()` becomes a span. `--config`, `--repeat`
(→ `--repeat-each`) and the PERF flags (`--cpu/--mem/--cov/--css/--trace/--net`)
are forwarded; `--emit-budgets` / `--gate` work per spec file. Same caveat as
auto-span: a span is one action's own cost, not "until the next assertion".

## Install (test fixture)

```sh
pnpm add -D lightbringer @playwright/test
```

`web-vitals` is pulled in automatically.

## Usage

Use the extended `test` fixture and measure named steps:

```ts
import { test, expect } from "lightbringer";

test("checkout flow", async ({ page, perf }) => {
  await perf.measure("initial-load", async () => {
    await page.goto("https://app.example.com");
    await expect(page.getByRole("heading")).toBeVisible();
  });

  await perf.measure("open-cart", async () => {
    await page.getByRole("button", { name: "Cart" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
```

Reports are written to `perf-results/<title>.run<idx>.json` and a summary is
logged. Put your `waitFor`/`expect` assertions **inside** the action so the span
covers "until the operation is done".

### Auto-span (measure an existing spec, ~1-line change)

To put numbers on a spec you already have, without wrapping anything in
`perf.measure`, import `test` / `expect` from `lightbringer/auto` instead of
`@playwright/test`:

```diff
- import { test, expect } from "@playwright/test";
+ import { test, expect } from "lightbringer/auto";
```

Every navigation and interaction in the spec body — `page.goto(...)` and Locator
actions like `getByRole(...).click()`, `locator(...).fill(...)` — becomes a
measured span automatically (labelled `goto /`, `click #inc`, …). The spec body is
otherwise unchanged. The same `perf-results/*.json` is written and the same PERF_*
flags apply.

Trade-off vs. explicit `perf.measure`: each auto-span covers **one action's own
cost** (the action plus a short settle), not "until your next assertion". When you
need the "until settled" window (e.g. goto **and** wait for the hero to paint as
one span), use the explicit `test` from `lightbringer` and `perf.measure`.

```sh
pnpm exec playwright test                       # measure
PERF_TRACE=1 pnpm exec playwright test          # also save a Chrome trace (Paint / GPU / drilldown)
PERF_CPU=4 pnpm exec playwright test            # throttle CPU 4x (mid-tier device)
PERF_GPU=1 pnpm exec playwright test            # hardware GL (real GPU/paint numbers)
PERF_MEM=1 pnpm exec playwright test            # force GC at span boundaries (retained-only memory deltas)
PERF_CSS=1 pnpm exec playwright test            # capture per-selector style-recalc match stats (in the trace)
PERF_COV=1 pnpm exec playwright test            # record JS+CSS coverage (chunk usage / dead code)
pnpm exec playwright test --repeat-each=5        # multiple runs for median
node node_modules/lightbringer/scripts/median.mjs
```

### CPU & network throttling (find bottlenecks hidden by a fast machine)

A fast dev machine on localhost hides both CPU and network cost.

- **`PERF_CPU=N`** slows the CPU N times (`Emulation.setCPUThrottlingRate`), so
  React re-render storms surface as long tasks. GPU/GL is **not** throttled, so it
  isolates JS/main-thread cost. The test timeout is auto-scaled by N; the global
  `expect()` timeout is not (raise it in config or pass an explicit timeout).
- **`PERF_NET=slow-3g|fast-3g|4g`** emulates a slower network
  (`Network.emulateNetworkConditions`), so payload size and waterfall depth have
  realistic cost (relevant when validating code-splitting / lazy loading).

### Median (kill the noise)

A single run is noisy (JIT / cache / GC). For regression checks and before/after
comparisons, run N times and take the median:

```sh
pnpm exec playwright test --repeat-each=5
lightbringer-median            # writes <slug>.median.json, prints median (p25..p75)
```

Each number is shown as `median (p25..p75)` — the IQR band, not min..max, so one
bad run doesn't blow up the reported spread. A metric whose IQR is wide relative to
its median is flagged **`!noisy`**: don't trust that median or gate on it without
more runs. On ad-heavy real sites this is common (e.g. `cpu.block` and recalc counts
swing run-to-run while `requestCount` stays stable). The budget gate decides on the
median but warns (`~`) when a budgeted metric is noisy and its IQR straddles the
budget, since the gate could then flip run-to-run.

### Drilldown (find the cause)

When a span's CPU is high, capture a trace and aggregate it within the span
window to see which subsystem and which functions spend the time:

```sh
PERF_TRACE=1 pnpm exec playwright test
lightbringer-drilldown <slug> <spanName>
```

It prints these views: an event-name breakdown (Layout / Paint / FunctionCall /
WebGL / `v8.parseOnBackground` / …), a function **total** time (includes children),
a function **self** time computed from the V8 CPU profiler — the latter is what
pinpoints the actual hot function (e.g. a specific React render), with V8 synthetic
frames like `(idle)` / `(program)` filtered out — a **GPU** rollup (GPUTask /
RasterTask), and **network initiators** (which code issued the span's requests,
straight from the report, so it needs no trace).

With `PERF_CSS=1` it also prints **CSS selector match cost** — per-selector style
recalc stats (`disabled-by-default-blink.debug` SelectorStats): the slowest
selectors by match time, and the *wasteful* ones (high `match_attempts`,
`match_count` 0 — re-tested against the DOM on every recalc but never matching,
prime candidates to delete or scope). This is the answer to "the DOM and selector
count are large and style recalc is expensive — which selectors?". Note `PERF_CSS`
instruments every match attempt, so it **inflates** the recalc time; use it to find
*which* selectors and read `recalcStyleMs` from a normal run for the real magnitude.

### App spans (`withSpan`)

To attribute cost to a region of your **application** code, wrap it with
`withSpan`. It emits a standard `performance.measure` (visible in the DevTools
Performance panel too), which lightbringer collects and converts into an
OpenTelemetry-style span, nested inside the operation span by time containment:

```ts
import { withSpan } from "lightbringer";

const stats = await withSpan("loadStats", () => fetchStats(id), { id });
```

Nothing is sent to a server. The `toOtelSpans` output is where an OTLP exporter
could plug in later.

### Custom settle

After an action, lightbringer waits for the page to "settle" before closing the
span. The default waits for two animation frames. Override it per call or per
controller for app-specific readiness (e.g. waiting for a map's `idle` event):

```ts
await perf.measure("pan-map", async () => { /* ... */ }, {
  settle: (page) =>
    page.evaluate(() => new Promise<void>((r) => myMap.once("idle", r))),
});
```

Settle is bounded by `PERF_SETTLE_TIMEOUT` (default 5000ms). If it times out the
span is flagged `capped` and its `durationMs` should not be trusted (read the
network / CPU / render breakdown instead).

### Memory leak trend (`measureRepeat`)

A single step's memory delta can't be told apart from GC noise. To catch a leak,
repeat the same operation and watch whether memory climbs every time:

```ts
await perf.measureRepeat(
  "toggle-panel",
  async () => {
    await page.getByRole("button", { name: "Toggle" }).click();
  },
  { times: 6 },
);
```

Each repeat is recorded as a `toggle-panel#0..#5` span; lightbringer then reports
whether the heap / listener count / DOM nodes / ArrayBuffer count grow
monotonically across them:

```
  memory trends (across repeated steps):
    toggle-panel x6  jsEventListeners 192→212→232→252→272→292  +100 (+20/step)  ⚠ likely leak
    toggle-panel x6  jsHeapUsedMB 12→21.2→30.4→39.6→48.8→58MB  +46MB (+9.2/step)  ⚠ likely leak
```

Run it under `PERF_MEM=1` so each repeat's memory is measured after a forced GC
(retained-only) — that's what makes even `jsHeapUsedMB` resolve into a clean line.
A non-leaking step reports no trend. This stays inside one scenario, so it isn't
the out-of-scope cross-scenario analysis.

### Coverage & chunk-split analysis (`PERF_COV`)

`PERF_COV=1` records JS + CSS coverage across the whole scenario (it doesn't reset
on navigation, so it accrues over every page and interaction). The per-run summary
shows how much of each chunk the scenario used:

```
  coverage (PERF_COV — scenario-wide):
  js   25.8% used  (547.1/2119.7KB)
       22.7% used  716KB unused  /assets/vendor-maplibre-….js
       17.1% used  286.8KB unused  /assets/vendor-turf-….js
  css  95.4% used  (96.5/101.2KB)
```

To find code that **no** scenario in the suite used (dead code / over-shipping),
run the whole suite with `PERF_COV=1`, then union the per-scenario coverage:

```sh
PERF_COV=1 pnpm exec playwright test
node node_modules/lightbringer/scripts/coverage.mjs --min=30
```

```
[coverage] union across 7 scenario run(s)
  JS  31% used overall  (640/2060KB, 1420KB never used)
    never used by any scenario (dead-code / over-shipping):
        45.2KB  /assets/admin-….js
    under 30% used (split too coarse / lazy-load candidate):
       17.1% used  286.8KB unused  /assets/vendor-turf-….js
```

A byte is "used" if *any* scenario executed it, so a chunk that stays low after
the whole suite is a real split/lazy-load candidate. Notes: measure a **production
build** (`vite build` + `vite preview`) — a dev server ships unbundled modules, so
chunk analysis is meaningless. A framework vendor chunk (react) sitting at ~25% is
expected and not splittable; the actionable signals are feature libs (e.g. turf
only needed for some geo ops) and your own app chunks. Coverage is Chromium-only.

## Budgets (CI regression gate)

Declare an upper bound per span; the build fails when it's exceeded. `scriptMs`
(CDP ScriptDuration) is the recommended bound because it is accurate to ~1ms.

```ts
await perf.measure(
  "open-cart",
  async () => {
    await page.getByRole("button", { name: "Cart" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  },
  { budget: { scriptMs: 80, blockingMs: 100 } },
);
```

Two gates, same declared budget:

- **Median gate (recommended for CI):** run N times, then `median.mjs` compares the
  median to the budget and **exits non-zero** on violation. Robust against the
  per-run noise of `durationMs` / `blockingMs`.

  ```sh
  pnpm exec playwright test --repeat-each=5
  node node_modules/lightbringer/scripts/median.mjs   # exit 1 if any median > budget
  ```

- **Inline gate (fast local fail):** `PERF_ASSERT=1` fails the test in teardown on
  the single run. Best for stable metrics (`scriptMs`); off by default.

Either way, violations are also printed in the per-run summary (`! budget: ...`).

Span budget fields: `durationMs`, `scriptMs`, `blockingMs`, `encodedKB`,
`requestCount`, `waves`, `busyMs`, `thirdPartyKB`, `thirdPartyRequestCount`,
`layoutCount`, `recalcStyleMs`, `recalcStyleCount`, `nodes`, `jsHeapUsedMB`,
`jsHeapDeltaMB`, `listenersDelta`, `interactionMs`, `droppedFrames`,
`longestFrameMs`, `paintCount` / `paintMs` / `gpuMs` (PERF_TRACE only). The memory bounds
(`jsHeapDeltaMB` especially) are only trustworthy under `PERF_MEM=1`; prefer the
count-based `listenersDelta` for a GC-stable gate. For page-global web-vitals,
declare a separate budget once per test:

```ts
perf.setVitalsBudget({ LCP: 2500, INP: 200, CLS: 0.1 });
```

It's gated the same way (median, with noisy warnings).

### Regression gate (baseline-relative)

Budgets are absolute bounds you maintain by hand. The other half of "drive the
optimization" is catching a relative regression without declaring a number — *the
PR made this step 35% slower than main*. Produce a baseline median set, then the
current one, and diff them:

```sh
# baseline (e.g. on main)
PERF_OUT_DIR=perf-baseline pnpm exec playwright test --repeat-each=5
PERF_OUT_DIR=perf-baseline node node_modules/lightbringer/scripts/median.mjs

# current (on the PR)
pnpm exec playwright test --repeat-each=5
node node_modules/lightbringer/scripts/median.mjs

# fail if anything got >15% worse
node node_modules/lightbringer/scripts/regress.mjs perf-baseline perf-results --threshold=0.15
```

```
[regress] baseline perf-baseline  vs  current perf-results  (gate: +15%)

  open-cart
    increment-click / render.scriptMs  2.1 → 133.1  (+6238%)  ✗
    increment-click / cpu.blockingMs    0   → 134    (new)     ✗
    increment-click / memory.jsHeapUsedMB  23.9 → 50.4 (+111%) ✗
    vitals.INP  24 → 152  (+533%)  ~
```

Every tracked metric is lower-is-better, so a regression is an increase past both
the relative gate **and** an absolute floor (so a 1ms→2ms swing isn't flagged as
+100%). A metric that's noisy on either side (wide IQR) is downgraded to a warning
(`~`) — the comparison can't be trusted, add runs. Exits non-zero on any hard
regression, so it drops straight into CI alongside the budget gate.

## CI

[`.github/workflows/perf.yml`](.github/workflows/perf.yml) is a working perf gate —
lightbringer measuring its own fixtures — that doubles as the copy-this template:

```yaml
- run: pnpm exec playwright install --with-deps chromium
- run: pnpm exec playwright test <your-specs> --repeat-each=5   # median needs N runs
- run: node node_modules/lightbringer/scripts/median.mjs        # exits 1 on budget violation
```

Two things make it reliable in CI:

- **Gate on the median, not a single run.** `--repeat-each=5` + `median.mjs`
  absorbs JIT/GC/cache noise and prints `median (p25..p75)`; a metric whose IQR is
  wide is flagged `!noisy` and shouldn't gate.
- **CI runners have no GPU** (SwiftShader), so budget the main-thread metrics
  (`scriptMs`, `layoutCount`, `nodes`, `requestCount`, `waves`, `recalcStyleMs`) —
  not `gpuMs`/`paintMs`, which are unreliable there.

To add the **baseline-relative regress gate** (catch "this PR got 15% slower than
main" without hand-set budgets), measure both revisions and diff:

```yaml
- run: pnpm exec playwright test <specs> --repeat-each=5
- run: node scripts/median.mjs            # current → perf-results/*.median.json
- name: baseline from main
  run: |
    git worktree add ../base origin/main
    cd ../base && pnpm install --frozen-lockfile
    pnpm exec playwright test <specs> --repeat-each=5
    PERF_OUT_DIR="$PWD/perf-results" node scripts/median.mjs
- run: node scripts/regress.mjs ../base/perf-results perf-results --threshold=0.15
```

The bench specs here default to their *slow* path (to demonstrate each metric), so
the template passes `BENCH_FIXED=1` to run the optimized path and stay green —
your own specs won't need that.

## API

Four ways to use it, then the full surface for each. The sections above are the
tutorial; this is the lookup.

### Entry points

| import / command | what you get |
| --- | --- |
| `import { test, expect } from "lightbringer"` | extended Playwright fixture exposing **`perf`** (below) — you mark spans with `perf.measure`. Also re-exports `withSpan` / `startSpan`, `PerfController`, `startSession`, `logSummary`, `toOtelSpans`, and the report types. |
| `import { test, expect } from "lightbringer/auto"` | same `test`, but every `page.goto` / Locator action becomes a span automatically — no `perf.measure` calls (see [Auto-span](#auto-span-measure-an-existing-spec-1-line-change)). |
| `import { … } from "lightbringer/analyze"` | the pure CDP-event analysis layer — builder functions + fragment types, **no Playwright / fs dependency** (below). |
| `npx lightbringer run <scenario.json \| spec.ts \| dir>` | the zero-install CLI (see [CLI](#cli-no-install-no-spec)). |

### `perf` — the measurement controller (fixture)

| method | what it does |
| --- | --- |
| `perf.measure(name, action, opts?)` | record one span covering `action` until the page settles; returns the action's result. `opts: { settle?: Settle; budget?: Budget }`. |
| `perf.measureRepeat(name, action, opts?)` | repeat `action` N times as `name#0..#N` for the leak trend. `opts: { times? = 3; settle?; budget? }`. |
| `perf.setVitalsBudget(budget)` | page-global web-vitals bounds: `{ LCP?; INP?; CLS?; TTFB?; FCP? }`. |

`Settle = (page) => Promise<void>` (default: two animation frames; capped by
`PERF_SETTLE_TIMEOUT`). `Budget` fields are listed under [Budgets](#budgets-ci-regression-gate).

### App-code spans

`withSpan(name, fn, attrs?)` wraps a region of **your app** code (emits a
`performance.measure`, collected and nested by time containment).
`startSpan(name) → { end() }` is the manual start/stop form.

### CLI

`lightbringer run <scenario.json | spec.ts | dir> [flags]` — a `.json` file runs
the scenario DSL; anything else runs through `playwright test` with your config.

| flag | effect |
| --- | --- |
| `--repeat N` | run N times (→ `--repeat-each=N` in spec mode) |
| `--out DIR` | report output dir (default `perf-results`) |
| `--config FILE` | Playwright config to reuse (spec mode) |
| `--emit-budgets` | write `lightbringer.budgets.json` from the medians (×1.25 headroom) |
| `--gate` | fail if a median exceeds the emitted budget |
| `--gpu` | hardware GL (real GPU / paint numbers) |
| `--cpu N` | throttle CPU N× |
| `--net slow-3g\|fast-3g\|4g` | network emulation |
| `--mem` / `--cov` / `--css` / `--trace` | enable the matching `PERF_*` analysis |
| `--headed` | show the browser |

### Env flags (test-fixture mode)

| var | effect |
| --- | --- |
| `PERF_TRACE=1` | save a Chrome trace; fills Paint/GPU and enables the drilldown |
| `PERF_GPU=1` | hardware GL (otherwise SwiftShader → fake GPU numbers) |
| `PERF_CPU=N` | throttle the CPU N× |
| `PERF_NET=slow-3g\|fast-3g\|4g` | network emulation |
| `PERF_MEM=1` | force GC at span boundaries (retained-only memory deltas) |
| `PERF_CSS=1` | per-selector SelectorStats in the trace (implies a trace) |
| `PERF_COV=1` | record JS + CSS coverage across the scenario |
| `PERF_ASSERT=1` | inline budget gate — fail the test in teardown on a single run |
| `PERF_OUT_DIR=DIR` | report output dir (default `perf-results`) |
| `PERF_SETTLE_TIMEOUT=MS` | settle cap before a span is flagged `capped` (default 5000) |
| `PERF_PORT=N` | fixture dev-server port (default 5173) |
| `PERF_COLOR=0\|1` | force summary colour off / on (default: on when stdout is a TTY; also honours `NO_COLOR`) |

### Scripts (also installed as bins)

| bin (`scripts/*.mjs`) | purpose |
| --- | --- |
| `lightbringer-median` | median (p25..p75) across runs; **exits 1** on a budget violation |
| `lightbringer-regress` | baseline-vs-current diff; exits 1 on a regression past the threshold |
| `lightbringer-drilldown` | trace breakdown for one span (needs `PERF_TRACE=1`) |
| `lightbringer-coverage` | union coverage across the suite (dead-code / over-shipping) |

### `lightbringer/analyze` (framework-agnostic analysis)

The part that turns raw CDP / Performance events into a report is a pure layer
with no Playwright, network, or filesystem dependency. It's published as a
separate subpath so you can reuse the analysis against events you captured some
other way (puppeteer, `chrome-remote-interface`, a saved trace):

```ts
import {
  buildSpanNetwork, // CDP Network records → per-span waterfall / 3p / initiators
  buildGlobalNetwork,
  diffMetrics, // Performance.getMetrics delta → style/layout/script/nodes
  buildTraceRender, // trace Paint/GPUTask → paint count / gpu ms
  buildSpanCpu, // long task / LoAF → blocking ms
  diffMemory,
  buildTrends, // repeated-step memory series → leak verdict
  buildCoverage, // V8/CSS coverage entries → used % per chunk (innermost-range)
  buildSpanInteraction, // Event Timing → per-step INP (input / processing / present)
  buildSpanFrames, // rAF timestamps → dropped frames / fps
  registrableDomain,
  isThirdParty,
} from "lightbringer/analyze";

// e.g. classify a captured request, or score a series you collected yourself
isThirdParty("https://cdn.other.com/a.js", "example.com"); // true
buildTrends(spans).find((t) => t.metric === "jsHeapUsedMB")?.leak;
```

Every function is a deterministic input→output transform (the per-domain report
fragment types — `SpanNetwork`, `SpanCpu`, `SpanRender`, `SpanMemory`,
`SpanInteraction`, `SpanFrames`, `Coverage`, `MemoryTrend` — live here too), unit
tested in isolation. `lightbringer`'s own collector is just the capture +
report-assembly driver on top of this layer.

## Accuracy

Measured against a known busy-loop in a page-owned click handler (see
`examples/accuracy.spec.ts`):

| metric | accuracy |
| --- | --- |
| `render.scriptMs` (CDP ScriptDuration) | ±1ms — the most reliable CPU number |
| `cpu.blockingMs` (Long Tasks API) | exact when it fires, but lossy (see below) |
| `durationMs` | ground truth + ~15–30ms harness overhead (CDP round-trips + settle) |
| tracing observer effect | negligible on `scriptMs` |

Things that bite, learned from the accuracy probe:

- **Work injected via `page.evaluate` is invisible** to the Long Tasks API and to
  ScriptDuration (only `durationMs` sees it). Drive the work from the page's own
  scripts/events, not from `evaluate`, or you will measure nothing.
- **`page.setContent` does not run init scripts** in this setup, so the in-page
  collector never initializes and vitals / cpu / render silently vanish (only
  `scriptMs` survives via CDP). Always reach the page with `page.goto` (a
  `data:text/html,...` URL works). The harness warns (`collectorMissing`) when it
  detects this.
- **PerformanceObserver callbacks are async**, so a long task at the very end of a
  span would be missed; the collector drains `takeRecords()` (`flush`) before
  reading, which fixes per-span attribution retroactively.

## Caveats

- **Default headless Chromium uses SwiftShader (software GL).** WebGL / ReadPixels
  / `gpuMs` and the `cpu.block` of GPU-heavy steps balloon far beyond real
  hardware and can mask real JS cost. Measure with **`PERF_GPU=1`** to use
  hardware GL (ANGLE Metal on macOS). Verify via the WebGL renderer string; on
  CI without a real GPU it stays SwiftShader, so don't trust map/canvas GPU/CPU
  numbers there.
- **Dev servers differ from production.** A dev server that serves unbundled ES
  modules inflates request counts and transfer size. Measure a production build
  for network/bundle decisions. Runtime responsiveness (INP) is build-independent.
- **`cpu.block` is the sum of long tasks.** Very short synchronous work, or work
  that doesn't cross a task boundary, may not register as a long task (it shows
  in LoAF instead). Use the trace for fine-grained attribution.
- **`logSummary` warns automatically** when the WebGL renderer is SwiftShader
  (software GL → fake GPU numbers) or when uncaught page errors occurred during
  the run (a broken / stale build makes the measurement invalid). The report
  carries `glRenderer` and `pageErrors`.
- The drilldown's **self** time comes from the V8 CPU profiler (sampling), so it
  is approximate at very short durations; the **total** view and event-name view
  complement it.
- **`(net-saturated: busyMs ≈ window)`** is shown when the network is busy for
  ~the whole span (continuous loading: ads, polling, long-polling). There, `busyMs`
  and `durationMs` reflect the wait window you chose, not a discrete load cost —
  read the discrete metrics (`cpu.block` / `script` / recalc counts / vitals) and
  `waves` / `requestCount` instead.
- **Heavy traces stream to disk.** A busy page emits tens-to-hundreds of MB of
  trace events; the collector streams them straight to `<slug>.trace.json` and
  keeps only Paint/GPUTask in memory, so the fixture doesn't buffer + stringify
  the whole trace (which would OOM). The `drilldown` script, however, loads the
  full trace file (`JSON.parse`) — fine for normal traces, but a multi-GB trace
  will strain it. `examples/stress.spec.ts` is the regression fixture for this.
- **Per-span request detail is capped at the 20 slowest.** `requestCount`,
  `encodedKB`, `busyMs`, `waves`, and `thirdParty` are computed over *all*
  requests; only the per-request `requests[]` list is truncated, so a
  request-heavy page doesn't bloat every report.
- **First/third-party split is by registrable domain** (eTLD+1) using a compact
  built-in suffix set, not the full Public Suffix List. It's correct for common
  hosts (subdomains of your site count as first-party; `*.co.uk` etc. handled),
  but exotic public suffixes may misclassify. The page's own domain (from
  `page.url()`) is the first-party anchor; `data:` / `blob:` count as first-party.
  Third-party **CPU** requires `PERF_TRACE=1` (the CPU profiler carries script URLs).
- **Memory deltas need a GC to be trustworthy.** Without `PERF_MEM=1` a span's
  `jsHeapDeltaMB` includes the step's own not-yet-collected garbage, so a fixed
  (non-leaking) step looks the same as a leaking one. `PERF_MEM=1` forces
  `HeapProfiler.collectGarbage` at both span boundaries so the delta is
  retained-only — but the GC adds wall time to the span, so it's opt-in and you
  shouldn't read `durationMs` from a `PERF_MEM` run. Even then, on-heap objects can
  survive a single step's GC, so `jsHeapDeltaMB` is directional; the **counts**
  (`listenersDelta`, ArrayBuffer count, document delta) are the reliable per-run
  leak signals. `JSHeapUsedSize` excludes off-heap buffer bytes (typed arrays /
  wasm / GPU staging), which is why a leaked 8 MB `Float64Array` shows only as the
  ArrayBuffer count going up, not as heap MB.
- **Request initiators are best-effort.** They come from CDP
  `Network.requestWillBeSent.initiator`: a `script` initiator carries a JS call
  stack (lightbringer keeps the topmost frame with a URL), a `parser` initiator
  points at the referencing document, and `preload` / `other` carry no frame. A
  fetch deep inside a bundled/minified vendor chunk attributes to that chunk's
  url:line, not your source, unless source maps are applied downstream.
- **Media analysis caveats.** Image over-fetch uses intrinsic vs rendered pixels,
  so it works for any `<img>`, but `data:` URLs and cross-origin images without
  `Timing-Allow-Origin` report 0 KB (they're not in Resource Timing) — the over-fetch
  ratio is still correct, only the byte figure is missing. The uncompressed-resource
  check depends on the serving layer: `vite preview` may not gzip, so it can flag
  chunks a real CDN would compress — confirm against production hosting.
- **Per-span interaction** uses Event Timing with a 16 ms `durationThreshold`, so
  sub-16 ms (already-responsive) interactions don't appear — absence is good news.
- **Frames** come from a rAF probe, so dropped frames are measured against a 60 Hz
  budget (16.7 ms) even though headless Chromium runs unthrottled (~120 fps) — a
  smooth span simply reports no hitch. The probe pushes one timestamp per frame
  (negligible), and the summary only prints the line when there's a real hitch.
- **Cache hits** are detected within the run (memory/disk/SW); a true reload-diff
  ("what's re-fetched on a second visit") means navigating twice in the scenario.
- **Render-blocking** counts `<head>` stylesheets and classic (non-async/defer,
  non-module) `<script src>`; a single app CSS bundle showing as 1 blocking sheet
  is normal — the signal is unexpected extra blocking resources.
- **`PERF_PORT` overrides the fixture dev-server port** (default 5173). Set it to a
  free port when another Vite project is already on 5173 — otherwise Playwright
  reuses that server and silently measures the wrong app.

## Bench fixtures

`fixtures/app` is a tiny React app (served by Vite) with deliberate, fixable
bottlenecks, grouped by the two halves of the responsibility — **initialization**
and **between steps**. Each spec in `examples/` measures one and doubles as a
regression fixture for the tool. `?fixed` (or `BENCH_FIXED=1`) toggles the fix.

**Initialization** (the `initial-load` span):

| scenario | bottleneck | metric | slow → fixed | fix |
| --- | --- | --- | --- | --- |
| init-eager | expensive work at boot that the first view doesn't need | `render.scriptMs` | 1038 → 21 ms | don't compute at init (lazy / on demand) |
| init-waterfall | boot fetches awaited one-by-one (fetch-on-render) | `network.busyMs` | 475 → 169 ms | parallelize the boot fetches |
| init-reflow | a mount layout effect forces a reflow per element | `render.layoutCount` | 2002 / 402 ms → 3 / 5 ms | batch reads then writes |
| cls | a banner inserted after load pushes content down | `vitals.CLS` | 0.4 (poor) → 0 | reserve the space up front |

**Between steps** (per interaction):

| scenario | bottleneck | metric | slow → fixed | fix |
| --- | --- | --- | --- | --- |
| rerender | unrelated heavy list re-renders on click | `render.scriptMs` | 129 → 1.8 ms | `React.memo` |
| reflow | write-then-read geometry in a loop (forced sync layout) | `render.layoutCount` / `layoutMs` | 2000 / 335 ms → 1 / 1.6 ms | batch reads then writes |
| input | heavy sync work per keystroke | `vitals.INP` | 64 → 8 ms | `useDeferredValue` |
| network | four independent requests awaited one-by-one | `network.waves` / `busyMs` | 4 waves / 808 ms → 1 / 203 ms | `Promise.all` |
| nplus1 | list, then one request per item | `network.requestCount` / `waves` | 6 / 6 → 2 / 2 | batch endpoint |
| chain | each request depends on the previous result | `network.waves` | 4 waves / 608 ms → 1 / 156 ms | combined endpoint |
| huge-dom | rendering 30k list items | `render.nodes` | ~120k nodes / layout 100 ms → ~400 / fast | windowing / pagination |
| paint | animating box-shadow every frame (no layout) | `render.paintCount` (PERF_TRACE) | 196 paints → 4 | animate `transform` (compositor-only) |
| thirdparty | analytics / ad / tag-manager scripts from another origin | `network.thirdParty` (KB / reqs / CPU) | 4 reqs / 265 KB / 70 ms CPU → 0 | drop / defer / self-host the script |
| leak | each click retains objects / buffers / listeners forever | `memory.listenersDelta` / `arrayBuffers` (PERF_MEM) | +19 listeners / +30 buffers → ~0 | drop refs, unbind listeners |
| leak-trend | the same leak, repeated 6× via `measureRepeat` | `report.trends` (PERF_MEM) | heap +9.2 MB/step monotonic → flat | drop refs, unbind listeners |
| selector-cost | big DOM × many matching complex selectors; toggle restyles all | `render.recalcStyleMs` (+ `PERF_CSS` drilldown) | ~22 → 0.5 ms | fewer / flatter / scoped selectors |
| image | a 1600×1600 image rendered in an 80×80 box | `report.media.oversized` | 400× over-fetch → 1× | serve at display size (or 2× DPR) |

`stress` is different: it doesn't measure an app bottleneck, it stresses
lightbringer's own data handling — 600 concurrent requests + a 150k-mark trace
(~50 MB / ~200k events). It verifies the collector survives a `dataCollected`
batch larger than the spread-call argument limit and streams the trace to disk
instead of OOMing. Run it with `PERF_TRACE=1`.

### Production fixture (build-dependent metrics)

Some axes only produce real numbers against a **production build** — a dev server
ships unbundled modules (no chunks), injects CSS via JS (no render-blocking
`<link>`), and the bench fixtures use `data:` images (0 bytes). `fixtures/bundle`
is a separate Vite project, built and `vite preview`-served by
`playwright.bundle.config.ts`, that makes them concrete:

```sh
PERF_COV=1 pnpm test:bundle      # build → preview → measure with coverage
pnpm coverage                    # union the per-scenario coverage
```

It surfaces, with real numbers:

- **chunk coverage** — `vendor-react` ~23% used (a big framework chunk the app
  barely exercises), and a `features` chunk imported as a namespace and dispatched
  dynamically, so it's shipped whole but ~25% used (the over-shipping pathology).
- **render-blocking** — the extracted `<link rel=stylesheet>` (1 css).
- **media over-fetch with real bytes** — a generated 1600×1200 PNG shown at
  128×96 (≈150× over-fetch, ~46 KB), not a 0-byte `data:` URL.
- **CSS coverage** — `style.css` has matching and non-matching rules, so CSS lands
  ~25% used.

The PNG is generated (`pnpm bundle:gen`, gitignored) so no binary is committed.

Notes worth internalizing:

- `reflow` / `init-reflow`: `scriptMs` is only ~5–8 ms, so a CPU-only view misses
  them — the layout breakdown is what surfaces the cost.
- the network trio is the waterfall fix taxonomy with zero CPU: **parallelize**
  independent requests, **batch** an N+1, **combine** a dependent chain.
- `init-eager`: deferring the work to idle would **not** help — that reschedules it
  without reducing the resource used at init; the fix is to not do it at init.
- the `rerender` drilldown's self time points straight at the app's own
  `expensiveValue` (with file:line), not a library.

```sh
npx playwright test reflow.spec.ts                 # slow
BENCH_FIXED=1 npx playwright test reflow.spec.ts    # fixed
```

## License

MIT
