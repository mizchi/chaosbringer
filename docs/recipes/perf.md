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

Every `--perf-*` flag implies `--perf`. CPU and network throttling are deliberately not perf options: the crawler already owns them (`faults.cpu()`, `--network`), and a second throttle on the same CDP session would overwrite the first.

## Spans

| Span | Opens | Closes | On |
|---|---|---|---|
| load | just before `page.goto` (after `beforeNavigation` lifecycle faults) | after `afterLoad` faults, the coverage baseline, `afterLoad` invariants and the metrics read | `PageResult.perf` |
| action | just before the crawler performs the action | just after it returns, including the crawler's own post-click `networkidle` wait | `ActionResult.perf` |

- All three action loops are measured: weighted random, `driver`, and `--trace-replay`.
- An action span covers the same interval as the `traceIds` the action collects. With `traceparent` and a server-fault collector you can join a slow span to the server-side events it caused.
- A skipped action (target not visible, nothing to select) is not a step, and records no span.
- A page whose `goto` times out still gets its load span: the crawler stops the pending load, closes the span and reports what the attempt cost.

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

Group, compare and budget by `key`. Phase 2 adds `perfBudgets` globs over it and `chaosbringer perf emit-budgets / gate / regress`.

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
