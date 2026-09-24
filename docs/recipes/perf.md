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

Every `--perf-*` flag implies `--perf`. The report's `reproCommand` carries the same `--perf*` flags (and `--perf-budgets <file>`), so a repro measures the way the run did. CPU and network throttling are deliberately not perf options: the crawler already owns them (`faults.cpu()`, `--network`), and a second throttle on the same CDP session would overwrite the first.

## Spans

| Span | Opens | Closes | On |
|---|---|---|---|
| load | just before `page.goto` (after `beforeNavigation` lifecycle faults) | after `afterLoad` faults, the coverage baseline, `afterLoad` invariants and the metrics read | `PageResult.perf` |
| action | just before the crawler performs the action | just after it returns, including the crawler's own post-click `networkidle` wait | `ActionResult.perf` |

- All three action loops are measured: weighted random, `driver`, and `--trace-replay`.
- An action span covers the same interval as the `traceIds` the action collects. With `traceparent` and a server-fault collector you can join a slow span to the server-side events it caused.
- A skipped action (target not visible, nothing to select) is not a step, and records no span.
- A page whose `goto` times out still gets its load span: the crawler stops the pending load, closes the span and reports what the attempt cost. Measurement never holds the crawl on a page that cannot answer: every in-page read lightbringer makes is bounded (5 s, and after one read times out the rest return at once).

Each span is a lightbringer `SpanReport`:

- `durationMs`, `capped`. `capped` is always `false` for now: the crawler does its own settling (`networkidle`) before it closes a span, so lightbringer never waits on a span and never hits its cap. It becomes meaningful with adaptive settle;
- `network`: request count, KB, busy time, waves, third-party share, top initiators, slowest requests;
- `cpu`: long-task count, `blockingMs` (total long-task time), heaviest task, LoAF;
- `render`: script / layout / style-recalc cost from CDP `Performance.getMetrics`, plus paint and GPU at trace level;
- `memory`: heap, DOM nodes and listeners at the end, and their deltas;
- `interaction` (per-step INP), present only when the span contained one;
- `frames` (rAF cadence: dropped frames, longest frame), present only with enough frames to describe.

Fields that were not measured are **absent, never 0**. A 0 passes every budget and reads as "measured, and fast".

`blockingMs` is lightbringer's *total* long-task time, not TBT. A single 120 ms click handler reads as `blockingMs ≈ 120`, and its TBT share, the part over the 50 ms long-task threshold, is about 70 ms. `PerformanceMetrics.tbt` is TBT-style (Σ `duration − 50`).

`PageResult.perfPage` holds page-level extras that do not belong to one span: web-vitals of the final document, per-document vitals when the page went through more than one, network totals, and the `clockPatched` / `collectorMissing` warnings.

## `perfKey`: the key that survives a rerun

Every span carries a `key`:

```
<urlPattern> :: <kind>
```

- **`urlPattern`** is the page's pathname after the crawler's usual URL normalisation. The origin, query and hash are dropped, so a baseline taken against `localhost:3000` matches a PR run against `localhost:41873`. Path segments that are all digits, UUIDs, or hex of 16+ characters become `:id`, so `/items/17` and `/items/42` share a key.
- **`kind`** is `load` for the load span. For an action it is `<type> <selector ?? target>`, the same selector `ActionResult.selector` records. A scroll is keyed as plain `scroll`, because its target is the random offset it scrolled to.
- **Fill values never enter the key.** The text an `input` typed is not on the `ActionResult` at all, and a `select`'s `value` is not part of the key.
- The route is the URL the crawler navigated to for that page visit. An action that changes the route (an SPA link) is still keyed by the page it started on.

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
- `--perf-budgets <file>` takes either a `perfBudgets` JSON array or an `emit-budgets` file (below), whose keys become exact-match rules. It implies `--perf`.

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

- **`emit-budgets`** writes `{ "version": 1, "headroom": 1.25, "budgets": { "<perfKey>": { "<metric>": n } } }`. It covers the eight metrics lightbringer's `--emit-budgets` covers: `durationMs`, `scriptMs`, `blockingMs`, `layoutCount`, `recalcStyleMs`, `encodedKB`, `requestCount` and `interactionMs`. Each budget is `ceil(median × headroom)`, so a metric whose median was 0 gets a budget of 0 (a click that made no request must keep making none). A key seen in fewer than half the reports is skipped, and the skipped keys are printed. A step that shows up in one run of five is a random pick, not something CI can hold a route to. `--headroom` must be at least 1.
- **`gate`** accepts either an `emit-budgets` file or a `perfBudgets` array. With the array, every matching rule applies and the tighter limit wins. A median over budget fails. A median within budget whose metric is **noisy** (IQR over 25% of the median) and whose p75 crosses the budget only warns: that gate could flip from run to run, so add runs. Budgets that matched no measured span are listed, not failed, as long as at least one budget did match; a gate that checked nothing fails. The keys of an `emit-budgets` file match literally (a `*` in a selector is not a wildcard there). An optional metric such as `interactionMs` is gated on the spans that measured it, the same sample `emit-budgets` took its median from.
- **`regress`** uses lightbringer's regress rules. A metric regresses only when it grows by more than `--threshold` (default 15%) **and** by at least its absolute floor (5 ms of `durationMs`, 1 request, and so on), so a 1 → 2 ms swing is not "+100%". A would-be regression on a noisy median only warns. A key with no baseline is listed as new; a baseline key the current reports never measured is listed too, without failing. This is what the `chaos-baseline` workflow's artefact plugs into: baseline reports on `main`, current reports on the PR.
- **`drilldown`** needs the crawl's per-page report and trace, so crawl with `--perf-trace`, optionally with `--perf-out <dir>`. The per-page report is found through `--perf-dir`, then the `--perf-out` in the report's repro command, then `./chaosbringer-perf`, each relative to the cwd and then to the report file's directory. When several spans share the key (the same button clicked on three visits), the slowest one is drilled. Without a trace, the error tells you which flag to rerun with.

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

### In this repo's CI

`chaos-baseline` (nightly and on every push to `main`) crawls the fixture site three times with `--perf` at the same seed as its chaos crawl and uploads the reports as the `chaos-perf-baseline` artefact. `chaos-pr-gate` crawls the PR the same way and runs `perf regress` against the latest successful baseline; a regression fails the job and the table lands in the job summary. When no baseline artefact exists yet (the first run after the workflow change, or an expired artefact), it prints a notice and skips, the way the chaos `--baseline` step already does. The baseline and the PR run land on different runners, so a PR that changes nothing can still see runner-to-runner drift. If that happens, raise `PERF_RUNS` in both workflows before you loosen the threshold or floors.

## Crawl-wide summary (`CrawlReport.perf`)

With `perf` on, the report gets a small `perf` block, and the reporter prints a few lines from it under "Across the crawl":

| Field | Contents |
|---|---|
| `vitals` | `LCP`, `INP`, `CLS`, `TTFB`, `FCP` → `{ p50, p75, worst: { value, url } }` over the pages that reported each one (nearest-rank percentiles) |
| `slowestActions` | the 10 longest action spans: `{ key, durationMs, blockingMs, interactionMs? }` |
| `hotInitiators` | the 10 heaviest request initiators across every span |
| `thirdParty` | third-party traffic per registrable domain across every span (top 10) |
| `totals` | `{ spans, pages }` measured |

`hotInitiators` and `thirdParty` add up the lists the crawl report keeps per span, which are the top five of each. A source that never made any span's top five is missing, so the totals are a lower bound. The per-page sidecars have the full lists. The summary is rebuilt from the merged pages when shards are merged.

## Levels and overhead

| Level | Adds | Rough cost | Enabled by |
|---|---|---|---|
| (always) | collector init script: web-vitals and observers. Without `--perf` there is no rAF probe; with it the probe runs on every document from its first frame, so load spans and spans of clicks that navigate get `frames` too | one script per document; with `--perf`, one rAF callback per frame | every crawl (feeds `lcp` / `tbt`) |
| `light` | `Performance.getMetrics` ×2 per span; CDP `Network.*` events on the shared session | 2 CDP round-trips per span | `--perf` |
| `trace` | `Tracing` streamed to disk; paint / GPU / CPU samples; drilldown | large, tens of MB per page | `--perf-trace` |
| `memory.forceGc` | `HeapProfiler.collectGarbage` ×2 at each span boundary | slow; changes timing | `--perf-mem` |
| `coverage` | JS/CSS coverage for the whole page visit | moderate | `--perf-cov` |

One reference measurement: the fixture site, `--seed 42`, 10 pages and 46 actions (56 spans), three runs each. Perf off took 32.3 s per run and `light` took 33.7 s: about 4%, or 25 ms per span. The same pages, actions and errors came out of both. Your numbers will differ. The cost is per span, so a crawl with many cheap actions pays proportionally more.

With `perf` unset, the crawler opens no CDP session for measurement and records no spans. The only perf work left is the always-on collector.

Durations include harness overhead: lightbringer's accuracy table puts `durationMs` 15–30 ms over the real cost. Budgets derived from medians absorb this, so compare a key's median against its own baseline rather than against an absolute target.

SwiftShader GPU numbers are not real: `render.gpuMs` is only meaningful at trace level with real GPU flags.

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
- **`testPage()` on a caller's page**: the crawler owns no context there, so a perf session installs the collector on the page itself. A page that was already loaded before that gets `collectorMissing` until its next navigation.
