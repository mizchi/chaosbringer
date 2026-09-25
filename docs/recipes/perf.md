# Per-step performance (`--perf`)

`performanceBudget` gives you one number per page: TTFB, FCP, LCP, TBT. That says a page is slow; it does not say which step made it slow. `--perf` measures each step the crawler takes — every page load and every chaos action — as a **span**, and reports what that span cost.

The measuring engine is [lightbringer](../../packages/lightbringer), which lives in this repo. chaosbringer decides *when* a span opens and closes; lightbringer does the measuring. The same span reports come out of `lightbringer run` for hand-written scenarios, so the numbers mean the same thing in both tools.

## Turning it on

```bash
chaosbringer --url http://localhost:3000 --seed 42 --perf
```

```ts
import { chaos } from "chaosbringer";

const { report } = await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  perf: true, // ≡ { level: "light" }
});
```

| Option (`perf: { … }`) | CLI | Default | What it does |
|---|---|---|---|
| `level: "light" \| "trace"` | `--perf-trace` for `"trace"` | `"light"` | see [Levels](#levels-and-overhead) |
| `memory: { forceGc: true }` | `--perf-mem` | off | GC twice at every span boundary, so memory deltas are what the step *retained* |
| `coverage: true` | `--perf-cov` | off | JS/CSS byte coverage per page (unused code) |
| `cssSelectorStats: true` | — | off | per-selector style stats in the trace; implies `level: "trace"` |
| `outDir` | `--perf-out <dir>` | — | write the full per-page report and artefacts (see [Artefacts](#artefacts)) |
| `actions: false` | — | `true` | measure page loads only |

Every `--perf-*` flag implies `--perf`. The report's `reproCommand` carries the same `--perf*` flags (and `--perf-budgets <file>`), so a repro measures the way the run did. CPU and network throttling are deliberately not perf options: the crawler already owns them (`faults.cpu()`, `--network`), and a second throttle on the same CDP session would overwrite the first. The `--network` presets (`slow-3g`, `fast-3g`) are chaosbringer's own and differ from lightbringer's `PERF_NET` / `--net` presets of the same names.

## Spans

| Span | Opens | Closes | On |
|---|---|---|---|
| load | just before `page.goto` (after `beforeNavigation` lifecycle faults) | after `afterLoad` faults, the coverage baseline, `afterLoad` invariants and the metrics read | `PageResult.perf` |
| action | just before the crawler performs the action | just after it returns, including the crawler's own settle: the post-click `networkidle` wait, or with `--settle adaptive` the adaptive settle after every action | `ActionResult.perf` |

- All three action loops are measured: weighted random, `driver`, and `--trace-replay`.
- An action span covers the same interval as the `traceIds` the action collects. With `traceparent` and a server-fault collector you can join a slow span to the server-side events it caused.
- A skipped action (target not visible, nothing to select) is not a step, and records no span.
- A page whose `goto` times out still gets its load span: the crawler stops the pending load, closes the span and reports what the attempt cost. Measurement never holds the crawl on a page that cannot answer: every in-page read lightbringer makes is bounded (5 s, and after one read times out the rest return at once).

Each span is a lightbringer `SpanReport`:

- `durationMs`, `capped`. The crawler does its own settling before it closes a span, so lightbringer never waits on a span and never hits *its* cap. `capped` is the crawler's verdict instead: `true` when the step's [adaptive settle](#settling-between-steps---settle) hit its cap. Under the default `networkidle` it is always `false`;
- `network`: request count, KB, busy time, waves, third-party share, top initiators, slowest requests. A request counts on the span that started it, never again on a later span it outlives, so a step that fired nothing reads `requestCount: 0` even while an earlier step's slow request is still running. `busyMs` is the exception: it is how long the network was busy inside the span, so that carried-over request adds its overlap there. A request with no response when the page's report is built (still in flight, or aborted because the crawler navigated away) is listed with `durationMs: 0` and `unfinished: true`;
- `cpu`: long-task count, `blockingMs` (total long-task time), heaviest task, LoAF;
- `render`: script / layout / style-recalc cost from CDP `Performance.getMetrics`, plus paint and GPU at trace level;
- `memory`: heap, DOM nodes and listeners at the end, and their deltas;
- `navigations`: how many documents the span navigated to (their navigation started inside it), absent when none. Every load has one, and so does a click that navigates. Read this rather than `memory.documentsDelta` to tell whether a step navigated: under `--perf-mem` the forced GC at the span's end collects the document it left before the reading, so `documentsDelta` reads 0 on a navigation;
- `interaction` (per-step INP), present only when the span contained one;
- `frames` (rAF cadence: dropped frames, longest frame), present only with enough frames to describe.

Fields that were not measured are **absent, never 0**. A 0 passes every budget and reads as "measured, and fast".

`blockingMs` is lightbringer's *total* long-task time, not TBT. A single 120 ms click handler reads as `blockingMs ≈ 120`, and its TBT share, the part over the 50 ms long-task threshold, is about 70 ms. `PerformanceMetrics.tbt` is TBT-style (Σ `duration − 50`).

- `faults` (chaosbringer's addition): the faults active during the span, sorted, absent when none. See [Perf under chaos](#perf-under-chaos-faults-and-degradation).

`PageResult.perfPage` holds page-level extras that do not belong to one span: web-vitals of the final document, per-document vitals when the page went through more than one, network totals, and the `clockPatched` / `collectorMissing` warnings. After a click that navigated away, the "final document" is the next page, not `PageResult.url`: `perfPage.vitals` are that page's, and `perfPage.documents` has each document's vitals under its own URL. The per-page sidecar is lightbringer's report, so its `url` and `vitals` are the final document's too (its file name and `title` are the visited page's).

## Settling between steps (`--settle`)

How long the crawler waits after each load and each action decides both how fast a crawl is and what the next step sees.

| `settle` | CLI | After `goto` | After an action |
|---|---|---|---|
| `"networkidle"` (default) | `--settle networkidle` | `waitUntil: "networkidle"` (500 ms with no connections) | `waitForLoadState("networkidle", 2000 ms)` after a click, then a fixed 100 ms |
| `"adaptive"` | `--settle adaptive` | `waitUntil: "load"`, then adaptive, capped at `timeout` | adaptive, capped at 2000 ms; no fixed pause |
| a number, e.g. `150` | `--settle 150` | as `"adaptive"`, with that quiet window | as `"adaptive"`, with that quiet window |

Adaptive settle resolves when **no request of the page has been in flight for the quiet window** (100 ms by default), **no long task ended within it**, and **at least two animation frames have run** since the step. Requests are counted from the page's own request events, and long tasks come from the always-on collector, read without draining it. EventSource streams are not counted. A request older than the cap no longer holds later steps: a hung request caps the step that fired it, not every step after it. A `hang` fault's parked route is treated the same way, and `drainHeldRoutes` still releases it when the page is done.

A settle that hits its cap does not fail the step or the page. It is reported: `capped: true` on the step's span (with `--perf`) and `PageResult.settleCapped`, the number of the page's settles that capped (present only under adaptive settle). A step that never goes quiet is a finding, where `networkidle` would spend a silent 2 s on it.

What `networkidle` really waits for after a click: `waitForLoadState` resolves at once when the current document has already reached networkidle, and after the load it has. So **a click that only fires an XHR is not waited for**. The next step starts after the fixed 100 ms, whether or not the response has rendered. Two things follow:

- **What the XHR renders reaches the next step only in a loop that looks again.** Adaptive settle waits for the XHR (up to the cap), so its result is on the page when the next step starts. A [driver](./drivers.md) re-collects candidates before every step and `--trace-replay` resolves each recorded selector as it goes, so both can then click what it rendered. The default random loop picks from the targets it collected once, when the visit started, so under either mode it never picks a control an XHR added later. In the 2026-09 evaluation a driver reached two XHR-rendered links in 5 of 5 seeds under adaptive and 1 of 5 under `networkidle`; the default loop gave the same result under both.
- **An XHR still in flight when the next step navigates is aborted, and that is reported as an app error.** Chromium cancels the page's own request, and the crawler records it like any failed request: a `network` cluster `<url> - net::ERR_ABORTED` (4 of 5 seeds in the same probe; none under adaptive, which waited for the response). It says the crawler moved on too early, not that the app is broken. Use `--settle adaptive`, or, if you accept losing real aborts too, `--ignore-error "net::ERR_ABORTED"` (patterns match the error message).

Adaptive settle **does not wait for timers**. It leaves the page once requests, long tasks and frames go quiet; a pending `setTimeout` does not hold it, so an error thrown or a promise rejected after that point happens after the crawler left and is never recorded. On a page whose scripts threw 150, 300, 800 or 2000 ms after load, or rejected after 500 ms (no actions, 5 reps each), `networkidle` caught 3 of the 5 in every rep, `--settle 250` caught 1, and `adaptive` and `--settle 50` caught none. Even `networkidle` missed the 800 and 2000 ms ones. Crawls with actions stay on each page longer and may catch more; that was not measured. **When the point of a crawl is late async errors, do not use adaptive or a short fixed settle**: use `networkidle`, or a fixed settle longer than the delay you expect.

Adaptive settle is **opt-in, and staying that way**. The default stays `networkidle`, so existing crawls, recorded traces and calibrated `TimingProfile`s keep their timing. The report's `reproCommand` carries `--settle` when it is not the default. The same-seed parity e2e (`settle.e2e.test.ts`) crawls the fixture site under both modes and checks they give the same visited pages and error fingerprints. On the fixture site (seed 42, 10 pages, 46 actions) a crawl took about 32.5 s under `networkidle` and about 8.8 s under adaptive, with identical pages, clusters and action sequences. That parity holds for the errors a step causes before it goes quiet, not for the late ones above.

Which mode, by purpose:

| Crawl for | Settle | Why |
|---|---|---|
| perf numbers, `perf regress` | `adaptive` | `durationMs` follows the app's work instead of the wait (below); about 3× faster |
| a driver exploring an app that renders from XHRs | `adaptive` | the next step sees what the XHR rendered, and no spurious `ERR_ABORTED` cluster |
| late async errors (timers, delayed rejections) | `networkidle` or a long fixed settle | adaptive leaves before they fire |

Under `networkidle`, **a span's `durationMs` is mostly the crawler's wait**, not the app: every load includes the 500 ms networkidle window, and the top "slowest" action spans in the evaluation were link clicks with 7–20 ms of network busy time inside about 600 ms of duration. Rank hotspots by `network.busyMs`, `cpu.blockingMs` and `render.scriptMs` there, or crawl adaptive: the same 120 ms server regression read +23% `durationMs` under `networkidle` and +94% under adaptive.

## `perfKey`: the key that survives a rerun

Every span carries a `key`:

```
<urlPattern> :: <kind>
```

- **`urlPattern`** is the page's pathname after the crawler's usual URL normalisation. The origin, query and hash are dropped, so a baseline taken against `localhost:3000` matches a PR run against `localhost:41873`. Path segments that are all digits, UUIDs, or hex of 16+ characters become `:id`, so `/items/17` and `/items/42` share a key.
- **`kind`** is `load` for the load span. For an action it is `<type> <selector ?? target>`, the same selector `ActionResult.selector` records. A scroll is keyed as plain `scroll`, because its target is the random offset it scrolled to.
- **Fill values never enter the key.** The text an `input` typed is not on the `ActionResult` at all, and a `select`'s `value` is not part of the key.
- For the load span the route is the URL the crawler navigated to for that page visit. For an action it is the URL the page was on when the action began, when that URL is on the visit's origin (otherwise, for an error page or an external site, the visit's). A click that navigates, by a full navigation or an SPA route change, is keyed by the page it started on; every later step of the same visit is keyed by the page it ran on. That includes a visit whose URL changed before its first step: when the server redirects `/admin` to `/login`, or an SPA does `router.replace("/dashboard")` on `/`, the load keeps the visit URL (`/admin :: load`) while every action of the visit, the first one too, is keyed by the redirect target (`/login :: click …`).

> **Key change (unreleased).** Earlier versions keyed every step of a visit by the visit's URL, so after a click that navigated, the rest of the visit was keyed under the old route: `/ :: click #buy` for a button on `/cart`. Those keys matched neither a candidate on the new screen nor that route's own visits. Now every action carries the route the page was on when it began. Steps before the visit's first navigation keep their keys, unless the visit itself redirected: then all of its action keys move to the redirect target, while its load keeps the visit URL. A baseline or `perfBudgets` rule that matched such a step under the old route (a navigated-away step, or any action of a redirected visit, such as a `/admin :: *` rule on a visit that lands on `/login`) has to be re-emitted (`perf emit-budgets`) or re-matched against the new route; `regress` lists such keys as new and missing until the baseline is refreshed.

Examples: `/ :: load`, `/items/:id :: click #buy`, `/search :: input input[name="q"]`, `/docs :: scroll`.

Group, compare and budget by `key`: `perfBudgets` globs over it, and `chaosbringer perf emit-budgets / gate / regress / drilldown` group by it (see below).

## Budgets per step (`perfBudgets`)

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  perfBudgets: [
    { match: "* :: load", budget: { durationMs: 3000, requestCount: 60 } },
    { match: "/cart* :: click *", budget: { blockingMs: 100, interactionMs: 200 } },
  ],
});
```

```bash
chaosbringer --url http://localhost:3000 --perf-budgets chaosbringer.perf-budgets.json
```

- **`match`** is a glob over the whole `perfKey`. `*` matches any run of characters, including none, spaces and `/`. Every other character is literal, because selectors are full of `.`, `[`, `(` and `?`. The glob must match the entire key: `"/cart"` matches nothing, and `"/cart :: *"` matches every span on `/cart`.
- **`budget`** is keyed by lightbringer's budget metrics: `durationMs`, `scriptMs`, `blockingMs`, `interactionMs`, `encodedKB`, `requestCount`, `waves`, `busyMs`, `layoutCount`, `recalcStyleMs`, `recalcStyleCount`, `nodes`, `thirdPartyKB`, `thirdPartyRequestCount`, `paintMs`, `paintCount`, `gpuMs`, `jsHeapUsedMB`, `jsHeapDeltaMB`, `listenersDelta`, `droppedFrames` and `longestFrameMs`. The list is lightbringer's `BUDGET_METRIC`, and an unknown name is refused.
- **Every matching rule applies**, not only the first. A broad rule and a tighter one for a hot route both hold, and each violation names the rule it broke.
- Rules are checked when the page finishes, against its load span and every action span. A breach is an `invariant-violation` named `perf-budget.<metric>`, the same path as `performanceBudget`. It fails the run and shows up in the reporter, error clusters, JUnit and `--baseline` diffs. Example message: `[perf-budget.blockingMs] /cart :: click #buy: blockingMs=153 > budget 100 (rule "/cart* :: click *")`.
- A metric the span did not measure is skipped, not failed. A load span has no `interactionMs`, and `paintMs` exists only at trace level.
- Rules need spans, so `perfBudgets` without `perf` turns measurement on at light level. `perf: false` together with rules is refused.
- `--perf-budgets <file>` takes either a `perfBudgets` JSON array or an `emit-budgets` file (below), whose keys become exact-match rules. It implies `--perf`. An `emit-budgets` file records the [settle mode](#settle-modes-and-comparisons) its budgets were measured under; a crawl with another `--settle` refuses it with exit 2 before a browser starts, because every action budget would fail (or pass) on the settle rather than on the app. `--allow-settle-mismatch` enforces it anyway, with a warning. A hand-written array, or a file written before the mode was recorded, is not checked.

A single run is noisy. A `perfBudgets` rule checks each span of *this* run, so give it the headroom of a hard ceiling ("a click never blocks for 200 ms"). For a budget at "what this route costs today", gate on medians with `perf gate`.

## Repeated runs: `chaosbringer perf`

These subcommands read crawl reports written with `--perf`. They group spans by `perfKey` and call lightbringer's own statistics (`aggregateRuns`, `spanMedians`, `emitBudgets`, `gate`, `regress`, `analyseDrilldown`), so they agree with `lightbringer run --emit-budgets / --gate` and lightbringer's scripts. Each operand may be a report file or a directory of them; other JSON in a directory is skipped and listed.

```bash
# 1. Measure: the same seed N times (or shards merged with `chaosbringer shard`)
for i in 1 2 3 4 5; do
  chaosbringer --url "$URL" --seed 42 --perf --output "runs/r$i.json"
done

# 2. Budgets from the medians: ceil(median × 1.25) per perfKey
chaosbringer perf emit-budgets runs/*.json            # → chaosbringer.perf-budgets.json

# 3. In CI: measure the PR the same way, gate on its medians
chaosbringer perf gate pr/*.json --budgets chaosbringer.perf-budgets.json

# Or with no hand-kept numbers: compare against a baseline artefact
chaosbringer perf regress baseline/ --current pr/*.json

# Why is one step slow? (needs --perf-trace)
chaosbringer perf drilldown runs/r1.json "/cart :: click #checkout"
```

| Subcommand | Reads | Exit 1 when |
|---|---|---|
| `emit-budgets <reports…> [--headroom 1.25] [--out chaosbringer.perf-budgets.json]` | every span per `perfKey` across the reports | no measured spans at all (the `--out` file is then left untouched) |
| `gate <reports…> --budgets <file> [--json]` | the medians per `perfKey` | a median is over budget, the budgets file is invalid, or nothing was gated (no reports, no spans, no budget matched a span) |
| `regress <baselineDir\|reports…> --current <reports…> [--threshold 0.15] [--json]` | the medians per `perfKey`, both sides | a metric regressed, or either side has no reports or no spans |
| `drilldown <report> <perfKey> [--top 15] [--perf-dir <dir>]` | the span's page trace | the span or its trace is missing |

`emit-budgets`, `gate` and `regress` exit **2**, not 1, when their inputs were crawled under different [settle modes](#settling-between-steps---settle) or record different perfKey versions, and compare nothing; `--allow-settle-mismatch` / `--allow-key-mismatch` compare anyway, with a warning. See [Settle modes and comparisons](#settle-modes-and-comparisons).

- **`emit-budgets`** writes `{ "version": 1, "headroom": 1.25, "budgets": { "<perfKey>": { "<metric>": n } } }`. It covers the eight metrics lightbringer's `--emit-budgets` covers: `durationMs`, `scriptMs`, `blockingMs`, `layoutCount`, `recalcStyleMs`, `encodedKB`, `requestCount` and `interactionMs`. Each budget is `ceil(median × headroom)`, so a metric whose median was 0 gets a budget of 0 (a click that made no request must keep making none). A key seen in fewer than half the reports is skipped, and the skipped keys are printed. A step that shows up in one run of five is a random pick, not something CI can hold a route to. `--headroom` must be at least 1.
- **`gate`** accepts either an `emit-budgets` file or a `perfBudgets` array. With the array, every matching rule applies and the tighter limit wins. A median over budget fails. A median within budget whose metric is **noisy** (IQR over 25% of the median) and whose p75 crosses the budget only warns: that gate could flip from run to run, so add runs. Budgets that matched no measured span are listed, not failed, as long as at least one budget did match; a gate that checked nothing fails. The keys of an `emit-budgets` file match literally (a `*` in a selector is not a wildcard there). An optional metric such as `interactionMs` is gated on the spans that measured it, the same sample `emit-budgets` took its median from.
- **`regress`** uses lightbringer's regress rules. A metric regresses only when it grows by more than `--threshold` (default 15%) **and** by at least its absolute floor (5 ms of `durationMs`, 1 request, and so on), so a 1 → 2 ms swing is not "+100%". A would-be regression on a noisy median only warns. A key with no baseline is listed as new; a baseline key the current reports never measured is listed too, without failing. This is what the `chaos-baseline` workflow's artefact plugs into: baseline reports on `main`, current reports on the PR.
- **`drilldown`** needs the crawl's per-page report and trace, so crawl with `--perf-trace`, optionally with `--perf-out <dir>`. The per-page report is found through `--perf-dir`, then the `--perf-out` in the report's repro command, then `./chaosbringer-perf`, each relative to the cwd and then to the report file's directory. Every page's per-page report is searched, not only the visits of the key's route: a step keyed by the route it navigated to (`/cart :: click #buy`) is in the report of the visit it started on (`/`). When several spans share the key (the same button clicked on three visits), the slowest one is drilled. Its `RunTask` line counts the renderer main thread's tasks only (the page's, which `cpu.blockingMs` is built from), not the browser process's, so its long tasks and `blockingMs` describe the same thread. Without a trace, the error tells you which flag to rerun with. In the self-time table, `[harness]` is measurement code rather than the app: the in-page collector chaosbringer injects (with its bundled web-vitals, whose minified frames read `A`, `i.m`, `r`), Playwright's injected and utility scripts, and chaosbringer's own `page.evaluate` helpers (target and link collection, the adaptive settle probe). Injected scripts have no URL, so a frame is recognised by name and then claims every other frame of its script. `[native]` is what is left: browser builtins such as `requestAnimationFrame`, and URL-less scripts nothing identifies, such as an app's own `eval` without a `sourceURL`. The per-selector CSS section needs SelectorStats in the trace; a crawl gets them from `perf: { cssSelectorStats: true }`, which has no CLI flag (lightbringer's `PERF_CSS=1` is read by its Playwright fixture, not by the crawler).

### Settle modes and comparisons

The settle mode changes what a span measures. Under `networkidle` the load span includes the networkidle wait and the fixed 100 ms pause after an action falls outside the action span; under adaptive the settle is inside the action span and the load stops once the page is quiet. The 2026-09 evaluation compared a `networkidle` baseline with an `adaptive` run of the same app and got `/admin :: scroll` 4.3 → 25.3 ms (+488%) and exit 1, and every load "improved" by about 75%, with nothing changed in the app.

So a crawl report records its mode in `perf.settle` (`{ "mode": "networkidle" }` or `{ "mode": "adaptive", "quietMs": 100 }`), `emit-budgets` copies it into the budgets file, and `emit-budgets`, `gate` and `regress` refuse, with exit 2, inputs that recorded different modes: baseline against current, reports against the budgets file, or reports of one side among themselves. Two adaptive quiet windows count as different modes. `--allow-settle-mismatch` runs the comparison anyway, with a warning on stderr. A report or budgets file written before the mode was recorded cannot be checked: it gets a warning, not a refusal, so re-crawl old baselines to get the check. A report merged from shards keeps the mode only if every shard recorded the same one. A `perfBudgets` array written by hand records no mode, so `gate` checks only the reports against each other. The crawler's own `--perf-budgets <file>` does the same check against the crawl's `--settle` (see [budgets per step](#budgets-per-step-perfbudgets)).

The same holds for what a key names. Reports also record `perf.keyVersion`, and `emit-budgets` copies it into the budgets file. Version 2 keys every action by the page it ran on. Version 1 is every report written before the version was recorded, and it keyed actions after a navigating click under the page the visit began at. The same key can therefore name different steps across versions, so `emit-budgets`, `gate` and `regress` refuse mixed versions with exit 2 as well; `--allow-key-mismatch` compares anyway, with a warning. An absent version is not a warning but version 1: it is known what those reports keyed. Re-crawl the baseline, or re-emit the budgets, after upgrading. In the `chaos-pr-gate` workflow, exit 2 is reported as a notice and skipped until `main`'s next baseline run records a comparable baseline.

Repeats should use one seed, so every run takes the same steps. A key that exists in only some runs is exactly what `emit-budgets` skips.

### How much noise to expect

Measured on the playground (`playground/README.md`, v1, `--seed 42 --max-pages 8 --max-actions 2`, three runs per batch, one machine), a baseline batch against six fresh clean batches and one batch with a 150 ms busy loop on `/users`:

| Check | clean batches failing | regressed batch |
|---|---|---|
| `perf gate`, budgets at ×1.25 (default) | 3 of 6 | fails: `/users :: load` `scriptMs` 156 > 5, `blockingMs` 150 > 0 |
| `perf gate`, budgets at `--headroom 2` | 0 of 6 | fails: same keys |
| `perf regress` | 0 of 6 | fails: `/users :: load` `durationMs` +31%, `scriptMs` 3.9 → 156, `blockingMs` 0 → 150, frame metrics |

The ×1.25 failures were all a sub-10 ms median: a 4 ms `scriptMs` gets a 5 ms budget, 1 ms of slack, and clean reruns read 5.1–5.7 ms. Headroom is relative, so it is thinnest exactly where timer granularity and scheduler jitter are largest. For a site whose spans cost single-digit milliseconds, emit with `--headroom 2` (or hand-raise the tiny budgets); a 150 ms regression still clears a doubled 4 ms budget by a factor of twenty.

`regress` needs no such adjustment because of its absolute floors. Two of them were raised for crawls while taking these numbers (`chaosbringer perf regress` passes them as floor overrides; `lightbringer-regress` keeps its own defaults of 16 ms and 2 frames): `longestFrameMs` from 16 to 17 ms, because frame durations come in whole 16.7 ms vsync intervals and a single late frame (16.8 → 33.3) failed a clean batch; and `droppedFrames` from 2 to 4, because headless Chromium on a shared CPU dropped 2–4 frames during a plain load with no app work (median 0 → 2 on a clean batch). The main-thread metrics (`scriptMs` floor 2 ms, `blockingMs` 5 ms) are the precise signal; the frame metrics catch jank of ~70 ms and up.

Headroom that held on a shared runner in the 2026-09 evaluation, for budgets you set by hand or raise after `emit-budgets`:

- `blockingMs`, `scriptMs`, `busyMs`: +20–25% or +20 ms over the median, whichever is larger. `busyMs` and `blockingMs` were stable to about 1 ms on seeded keys, but `scriptMs` moved by up to 3.5 ms between clean batches and `blockingMs` has occasional 50–70 ms outliers (a single long task where there is usually none).
- `durationMs` under `networkidle`: gate only on large changes, since most of it is the settle wait (see [settling](#settling-between-steps---settle)).
- Always gate on the median of 3–5 or more runs, never on one run.
- For CPU regressions, gate on `scriptMs` rather than `blockingMs`. `scriptMs` scales with the work (`faults.cpu(4)` multiplied it by about 4.5–5); `blockingMs` counts only tasks over 50 ms, so it reads 0 until the work crosses that line and then jumps by the whole task.

Under load (`scenarioLoad`) with more workers than cores, allow about +15% on blocking p95 and 2–3× on latency p95.

### In this repo's CI

`chaos-baseline` (nightly and on every push to `main`) crawls the fixture site three times with `--perf` at the same seed as its chaos crawl and uploads the reports as the `chaos-perf-baseline` artefact. `chaos-pr-gate` crawls the PR the same way and runs `perf regress` against the latest successful baseline; a regression fails the job and the table lands in the job summary. When no baseline artefact exists yet (the first run after the workflow change, or an expired artefact), it prints a notice and skips, the way the chaos `--baseline` step already does. The baseline and the PR run land on different runners, so a PR that changes nothing can still see runner-to-runner drift. If that happens, raise `PERF_RUNS` in both workflows before you loosen the threshold or floors.

## Crawl-wide summary (`CrawlReport.perf`)

With `perf` on, the report gets a small `perf` block, and the reporter prints a few lines from it under "Across the crawl":

| Field | Contents |
|---|---|
| `vitals` | `LCP`, `INP`, `CLS`, `TTFB`, `FCP` → `{ p50, p75, worst: { value, url } }` over the documents that reported each one (nearest-rank percentiles). A visit that navigated counts each of its documents under that document's URL, so `worst.url` is where the value was measured |
| `slowestActions` | the 10 longest action spans: `{ key, durationMs, blockingMs, interactionMs? }` |
| `hotInitiators` | the 10 heaviest request initiators across every span |
| `thirdParty` | third-party traffic per registrable domain across every span (top 10) |
| `totals` | `{ spans, pages }` measured |
| `degradation` | the 10 `(perfKey, fault)` pairs whose steps got slowest under the fault; see [below](#perf-under-chaos-faults-and-degradation). Absent without faults |
| `trends` | memory that climbs across repeats of one step; see [Leaks](#leaks-from-steps-the-crawl-repeats). Absent when nothing climbs |
| `coverage` | JS/CSS coverage unioned over the crawl; see [Coverage](#coverage-over-the-whole-crawl). Only with `perf.coverage` |

`hotInitiators` and `thirdParty` add up the lists the crawl report keeps per span, which are the top five of each. A source that never made any span's top five is missing, so the totals are a lower bound. The per-page sidecars have the full lists. The summary is rebuilt from the merged pages when shards are merged; `coverage` is the exception and is absent from a merged report, since byte ranges cannot be unioned from each shard's totals.

## Perf under chaos: faults and degradation

A span's `faults` names every fault that took effect in its window:

| Layer | Tagged onto | Name |
|---|---|---|
| network (`faultInjection`) | the spans open when the rule fired on a request (a delay tags the span that made the request) | the rule's `name`, or its pattern: the `faultInjections[].rule` label |
| lifecycle (`lifecycleFaults`) | the span open when it fired and every later span of the same page visit: a CPU throttle or wiped storage lasts the visit. `beforeNavigation` faults tag the load span | the lifecycle stats name (`cpu-throttle:4x`, or `name`) |
| runtime (`runtimeFaults`) | every span: the fault script is on every page | the runtime stats name |
| server (`server-faults` + `traceparent`) | the span whose requests carried the event's trace id | `server:<kind>` (`server:5xx`, `server:latency`) |

`CrawlReport.perf.degradation` compares, for each perfKey and each fault on its spans, the median span *with* the fault against the median *clean* span, one that carries none of the key's faults:

```jsonc
{ "key": "/item/:id :: load", "fault": "api-delay",
  "faulted": { "n": 4, "durationMs": 452, "blockingMs": 0, "requestCount": 3 },
  "clean":   { "n": 4, "durationMs": 118, "blockingMs": 0, "requestCount": 3 },
  "delta":   { "durationMs": 334, "blockingMs": 0, "requestCount": 0 } }
```

- A pair appears only when both sides have a span. A fault that hit every span of a key (any runtime fault) has nothing to compare with, and a page is visited once per crawl, so a load key needs a route pattern several pages share (`/item/:id`) or a probabilistic fault on a step the crawl repeats.
- The clean side leaves out every span that carries another fault, since that fault's cost is in it (a key whose loads were all hit by either server latency or a 503 used to read the 503 as "300 ms faster", against the latency-faulted loads). The exception is a fault on every span of the key, such as a runtime fault: it cannot be compared, so it is the key's baseline and does not disqualify a span. A key with no clean span gets no row. The faulted side is every span with the fault, so two faults that always fire together each get a row, with the other's cost included.
- Under the default `networkidle` settle, **a latency fault on a request a click fires does not show in the click's `durationMs`**: the post-click wait does not wait for that request (see [settling](#settling-between-steps---settle)), so the span closes a few ms after the request starts, delayed or not, and the delta is click-to-click noise (the 2026-09 evaluation read −17 to −30 ms for a 300 ms delay on an XHR button, and +281 ms under adaptive). Load spans are not affected. Compare such steps under `--settle adaptive`, which waits for the request inside the span.
- `interactionMs` appears on each side only over spans that had an interaction, and in `delta` only when both sides did.
- Sorted by `delta.durationMs`, largest first; the reporter prints the top five as "Degradation under faults". A `requestCount` delta is the retry storm the `amplification` oracle counts, priced in time.

Comparing across runs instead, one crawl without faults against one with them:

- **The same seed does not give the same crawl.** A fault with a `probability` between 0 and 1 draws from the crawler's seeded RNG, the one that also picks actions, so adding it shifts every later pick: in the evaluation the clean run and the delayed run at one seed clicked through to different users ("User 4" against "User 8"). Either compare within one run through `degradation`, or give the fault a [`schedule`](../../packages/chaosbringer/README.md#deterministic-schedules), which consumes no RNG and leaves the action sequence as it was. A probability of 0 or 1 draws nothing either.
- For a lifecycle fault such as `faults.cpu()`, use a partial probability (say 0.5) when you want `degradation`: at probability 1 it hits every span of the visit and leaves no clean span to compare against.
- Read a CPU throttle through `render.scriptMs`, which scales with it (`faults.cpu(4)`: about 4.5–5×), not through `blockingMs`, which stays 0 until a task crosses 50 ms.

## Leaks from steps the crawl repeats

lightbringer finds leaks in the `#0..#N` repeats of a `measureRepeat`. A crawl repeats steps without being asked: the same nav click on every page, the same button clicked again. `perf.trends` runs lightbringer's `buildTrends` over the spans that share a perfKey, in crawl order (loads by visit, actions by time), so its rules apply unchanged: at least three repeats, and only growth that is sustained, spread across the repeats and past the gauge's floor (10 listeners, 50 DOM nodes, 2 MB heap, 5 ArrayBuffers) is reported. `name` is the perfKey.

The gauges are the renderer's totals at each span's end, and a document the crawl navigated away from stays counted until a GC collects it. A run of full navigations therefore climbs on garbage alone (on the fixture site, each nav link repeated three times "leaked" about 34 listeners a step), so spans that created a document (every load, and every action with `navigations`; for older reports, `memory.documentsDelta > 0`) are left out. Load spans are never trended, whatever their gauges read. The garbage also shows in the totals of every span after a navigation, so a key's repeats form one series only while no document was created between them: a button clicked in between nav clicks on the same visit starts a new series after each navigation, and each series is judged on its own (a key can appear once per run that climbed). What remains are runs of steps that stay on one document, such as a client-side nav click or a button, where a climb is retention.

**Read `trends` only from a `--perf-mem` crawl.** Without the forced GC at span boundaries, the garbage a step leaves on its own document counts as growth too: a button that adds and removes 20 listeners and 100 nodes per click read listeners 91 → 375 without GC and a flat 29 with it. In the 2026-09 evaluation every non-leaking single-document run was flagged without `--perf-mem` (10 of 10) and none with it, while the real leaks were flagged both ways. A `trends` entry from a crawl without it is not evidence of a leak. `--perf-mem` slows every span (about 25–40 ms each), so run it as a separate leak-hunting crawl, not on the crawl whose `durationMs` you gate on. Navigations are told apart by `navigations`, from the new document's start time, because under `--perf-mem` `documentsDelta` reads 0 on them.

## Coverage over the whole crawl

With `perf.coverage` (`--perf-cov`), each page's JS/CSS coverage is folded into one union as the crawl goes, and `perf.coverage` reports `{ js, css }`, each `{ totalBytes, usedBytes, usedPct, lowUsage }`, where `lowUsage` lists up to 10 resources with the most unused bytes (fully used ones are left out, so it can be shorter or empty). `usedPct` is absent for a kind the crawl saw nothing of (`totalBytes: 0`, such as JS on a site without scripts). A byte counts as used if any page visit executed it.

A page with several inline `<script>` or `<style>` blocks lists each one as `<page url>#inline-1`, `#inline-2`, … in document order (Chromium reports them all under the page's URL, each with offsets from 0); a page with one keeps the bare URL. The keys are the same on every visit of the page, so they union across the crawl. Blocks are told apart by content, since a coverage entry does not say which document it came from: a script whose content changes per response (an inline block embedding a CSRF token or the server time, or a dynamically generated external file) that one visit loads twice (a reload, a form posting back to its own URL) is split into one `#inline-<n>` row per response, with the suffix even on an external URL, and its bytes are counted once per response.

CSS usage is only that of the last document of each page visit. When an action navigates, Chromium's rule-usage tracking forgets the rules the earlier document used: its stylesheets are still listed, with no used rules. A stylesheet the next page shares therefore only counts what the next page used, and one only the earlier page loaded reads 0%. This includes the visited page itself when one of its actions navigates away, so with actions on, CSS numbers are a lower bound. This is a Chromium limitation: taking a usage delta before each navigation is a race with the old document going away, and a second tracking session would take the deltas from Playwright's. JS coverage keeps every document.

This is lightbringer's `coverage` script's union, but over a crawl rather than over hand-written scenarios: it includes every page and action the crawler reached, including ones no spec covers. Code that stays unused here is a much stronger dead-code or over-shipping signal. It is still only what this crawl reached; a flow behind a login the crawler never passed is unused here too.

## Steering the crawl by cost: `lastActionPerf` and `perfSeekingDriver`

With `perf` on, each driver step carries what the previous action on the page cost, and the advisor's context carries the same thing:

```ts
step.lastActionPerf
// { key: "/cart :: click #apply", durationMs: 412,
//   cpu: { blockingMs: 180, longTaskCount: 2 },
//   interaction?: { maxDurationMs, type, inputDelayMs, processingMs, presentationMs, count },
//   network: { requestCount: 3, encodedKB: 12.4 } }
```

- It is a `Pick` of the action's span (`LastActionPerf`), read as the step starts, from what lightbringer has collected so far. That read is node-side filtering with no page call, and it happens once per action and only when a step asks for it.
- **Absent, never zeroed** when there is nothing measured: perf off, `perf.actions: false`, the page's first step, or a previous action whose span was not recorded. A driver can therefore tell "not measured" from "cost nothing".
- Read mid-page, it can differ from the report's copy of the same span. A request still in flight counts without its bytes. `interaction` is often missing, because the browser reports an interaction only after the paint that ends it, and under the default `networkidle` settle that usually lands after the span closed. The long task behind a slow handler is there.
- `key` joins the fact to a candidate: `candidatePerfKey(step, candidate)` is the key that candidate's span will carry. Pass the step, not `step.url`: the key follows the route the page is on (`step.currentUrl`), which differs from the visit's once an action has navigated. A string argument is used as the route URL as it is. The key contains the selector, so it stops at the model seam. `aiDriver` hands its provider the facts without `key`, and the bundled providers add one line under the action history ("Previous action cost: 412ms, 180ms main-thread blocking over 2 long tasks, 3 requests (12.4 KB)"). Without perf the prompts are byte-for-byte what they were.

`perfSeekingDriver()` uses those facts to look for the slowest interaction, where coverage feedback looks for the newest code:

```ts
import { readFileSync } from "node:fs";
import { chaos, perfSeekingDriver, type CrawlReport } from "chaosbringer";

// Optional: start from what was slow last run. Keys drop the origin.
const prior = JSON.parse(readFileSync("baseline.json", "utf8")) as CrawlReport;

await chaos({
  baseUrl,
  perf: true,
  driver: perfSeekingDriver({ prior, epsilon: 0.2 }),
});
```

- A candidate's weight is the mean observed cost of its perfKey, `blockingMs + interaction.maxDurationMs`, plus a 1 ms floor. Costs come from the steps of this crawl and, with `prior`, from every action span in an earlier report. `durationMs` is not part of the cost: it includes settle and network time, so a step that is slow only because its request is slow would outrank one that freezes the page.
- Candidates that have not been measured are explored in two ways. With probability `epsilon` (default 0.2) the pick is uniform among them. Otherwise each one is weighted as if it cost the average of the measured candidates on the same screen. Without that second rule, the first key the driver measured, cheap or not, would crowd out every control it had not tried yet.
- Every draw comes from `step.rng`, so a seed reproduces the same picks for the same measurements. Measurements vary from run to run, so a key's mean cost is rounded down to a 5 ms bucket (`PERF_SEEKING_COST_BUCKET_MS`) before it becomes a weight. Jitter of a millisecond or two then leaves the weights alone: every key under 5 ms weighs the floor, and near-tied candidates no longer swap between runs of the same seed. A mean that sits on a bucket edge can still flip, and a real cost change (a step that got 20 ms slower) still changes the picks, as it should.
- It needs perf on. When an action has run and nothing was measured, it warns once (`onWarn`, default `console.warn`) and picks uniformly until a measurement arrives. A `prior` is not used on its own in that case.
- The last action on each page is never seen by a later step, because the next page starts without a previous action. Its span still reaches the report, and from there any later run's `prior`.

On a page of five buttons where one handler blocks for 150 ms, the e2e test (`perf-seeking.e2e.test.ts`) saw the slow button take about 16 of 24 steps under `perfSeekingDriver`, against 6 of 24 under `weightedRandomDriver` with the same seed.

## Levels and overhead

| Level | Adds | Rough cost | Enabled by |
|---|---|---|---|
| (always) | collector init script: web-vitals and observers. Without `--perf` there is no rAF probe; with it the probe runs on every document from its first frame, so load spans and spans of clicks that navigate get `frames` too | one script per document; with `--perf`, one rAF callback per frame | every crawl (feeds `lcp` / `tbt`) |
| `light` | `Performance.getMetrics` ×2 per span; CDP `Network.*` events on the shared session | 2 CDP round-trips per span | `--perf` |
| `trace` | `Tracing` streamed to disk; paint / GPU / CPU samples; drilldown | large, tens of MB per page | `--perf-trace` |
| `memory.forceGc` | `HeapProfiler.collectGarbage` ×2 at each span boundary | slow; changes timing | `--perf-mem` |
| `coverage` | JS/CSS coverage for the whole page visit (CSS: its last document only; see [Coverage](#coverage-over-the-whole-crawl)) | moderate | `--perf-cov` |

One reference measurement: the fixture site, `--seed 42`, 10 pages and 46 actions (56 spans), three runs each. Perf off took 32.3 s per run and `light` took 33.7 s: about 4%, or 25 ms per span. The same pages, actions and errors came out of both. Your numbers will differ. The cost is per span, so a crawl with many cheap actions pays proportionally more.

With `perf` unset, the crawler opens no CDP session for measurement and records no spans. The only perf work left is the always-on collector.

Durations include harness overhead; see lightbringer's [accuracy table](../../packages/lightbringer/README.md#accuracy). Budgets derived from medians absorb it, so compare a key's median against its own baseline rather than against an absolute target.

GPU numbers under headless SwiftShader are not real; see lightbringer's [caveats](../../packages/lightbringer/README.md#caveats). In a crawl, `render.gpuMs` is only present at trace level.

## Artefacts

Set `outDir` (`--perf-out <dir>`) and each measured page writes:

| File | When | Contents |
|---|---|---|
| `<run>-<NNN>-<route>.json` | always | lightbringer's full `PerfReport` for the page visit: every span with its `key`, untrimmed request lists, app spans, CSS/DOM profile, media and render-blocking analysis |
| `<run>-<NNN>-<route>.trace.json` | `level: "trace"` | the Chrome trace; open it in DevTools' Performance panel |
| `<run>-<NNN>-<route>.coverage.json` | `coverage: true` | the coverage artefact lightbringer's `coverage` script consumes |

`NNN` is the page's index in the crawl, so two visits to one route do not overwrite each other. `run` is a random id per crawl (per test with the Playwright fixture, which builds a crawler for each test), so two runs sharing an `outDir` do not overwrite each other either. `PageResult.perfPage.reportPath` is the report's path relative to `outDir`.

Without `outDir` nothing is written, with one exception: a trace has to be streamed somewhere, so `level: "trace"` without `outDir` writes to `./chaosbringer-perf`.

The crawl report itself stays small. Each span keeps its top five `network.requests`, `network.byInitiator` and `network.thirdParty.byDomain`; the totals still count every request.

## Caveats

- **Chromium only**: the whole layer is CDP, like the rest of the crawler.
- **`clock-skew` runtime faults**: the collector is installed before the runtime-fault script and captures the unpatched clock, so spans stay correct. If page JS had patched `performance.now` before the collector ran, `perfPage.clockPatched` is set.
- **Load runs**: `scenarioLoad({ perf: true })` measures each scenario step on a sampled worker, light level only — see [scenario-load.md](./scenario-load.md#recipe-browser-cost-under-load-perf). A run's last iteration, when the `duration` deadline cuts it short, is not counted as an iteration (`totals.truncatedIterations`); the steps it ran are measured as usual.
- **Step counts after a navigating click differ by loop.** A driver re-collects the page's controls before every step, so after a click that navigated it picks from the new page and keeps taking steps. The default (no-driver) loop picks from the controls it collected when the visit started; after a navigation most of them are gone, so its picks are skipped as not visible and the visit can end with fewer than `maxActionsPerPage` steps (for example 42–43 against a driver's 50 over ten visits). Both key each step by the page it ran on.
- **A click that navigates almost never has `interaction`.** The browser reports an interaction after the paint that ends it, and a click that leaves the document usually unloads it before that paint, so a link click's span has no `interactionMs` (in a load run, a same-document button click got it on 20 of 20 spans and a link click on none of 19). An `interactionMs` budget on such a step is skipped in a crawl and fails with `actual: null` as a `scenarioLoad` SLO. Budget the step on `blockingMs` and `durationMs`, and `interactionMs` on the clicks that stay on the page.
- **Work run through `page.evaluate` is not a long task.** The Long Tasks API does not see a busy loop the harness injects with `page.evaluate`, and so neither does `blockingMs`; the same loop scheduled with `setTimeout` from inside the page reads its full length. This matters for a custom driver action or a load-run step that simulates work that way: trigger the page's own handlers (click, type) instead. See lightbringer's [accuracy notes](../../packages/lightbringer/README.md#accuracy).
- **`testPage()` on a caller's page**: the crawler owns no context there, so a perf session installs the collector on the page itself. A page that was already loaded before that gets `collectorMissing` until its next navigation.
