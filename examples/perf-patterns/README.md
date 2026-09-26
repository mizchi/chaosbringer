# Perf patterns: improvable sample apps

A catalog of tiny pages, each with a known performance anti-pattern (the
**slow** variant) and its idiomatic fix (the **fixed** variant). For every
pattern, a chaosbringer crawl with `perf` on, and no hand-written scenario,
has to:

1. **localise** the problem on the slow variant: the expected metric is
   measured on the expected step (its [perfKey](../../docs/recipes/perf.md#perfkey-the-key-that-survives-a-rerun));
2. **show the fix**: the same metric on the same key improves by at least the
   pattern's threshold on the fixed variant, and the fixed crawl still visits
   the same pages with no new error clusters.

Some patterns are **chaos-only**: the page is fine while the network is
healthy, and the problem appears only under an injected fault
(`faults.status` / `delay` / `hang`). A crawler that injects faults while it
measures is what makes those visible.

## Run it

```bash
pnpm install                       # builds chaosbringer's dist via `prepare`

pnpm test                          # every pattern, both variants, as assertions
PATTERN=layout-thrash pnpm test    # one pattern (comma-separate several)
pnpm report                        # measure all and rewrite the table below
pnpm typecheck
```

`PERF_PATTERN_RUNS` (default 3) sets how many crawls per variant the medians
are taken over.

## Results

Each row: which perfKey and metric the crawl flags, the median on each
variant, and how much the fix gains. "−99% (200×)" means the fixed median is
1/200th of the slow one. Medians are pooled over every matching span of every
run: a key that the crawl hits four times per run over three runs is twelve
values.

<!-- results:start -->
Medians over 3 crawls per variant at the pattern's seed; measured by `pnpm report` on 2026-09-26.

| pattern | category | what chaosbringer flags (perfKey · metric) | slow | fixed | improvement | fix |
|---|---|---|---|---|---|---|
| [duplicate-fetch](src/patterns/duplicate-fetch.ts) | network | `/ :: load`<br>`network.requestCount` | 4 | 2 | −50% (2.0×) | Deduplicate: share one in-flight promise (or a request cache such as SWR / React Query / a DataLoader). |
| [expensive-selectors](src/patterns/expensive-selectors.ts) | render | `/ :: click button:has-text("Dark toolbar")`<br>`render.recalcStyleMs` | 24.1 | 0.2 | −99.2% (121×) | Toggle the class on the element that changes and scope rules to it (or use CSS custom properties); avoid universal/:has() rules keyed off <body>. |
| [hang-no-timeout](src/patterns/hang-no-timeout.ts) | chaos | `/ :: load`<br>`effectiveMs`<br>under `slow-6s` | 6135 | 1127 | −82% (5.4×) | Put a deadline on the request (AbortController / AbortSignal.timeout) and show a fallback with a retry. |
| [huge-dom](src/patterns/huge-dom.ts) | render | `/ :: load`<br>`render.nodes` | 60055 | 655 | −99% (92×) | Paginate or virtualise the list: render only the rows in view (here one page of 50). |
| [input-no-debounce](src/patterns/input-no-debounce.ts) | network | `/ :: click button:has-text("Type a query")`<br>`network.requestCount` | 20 | 2 | −90% (10×) | Debounce the input handler (~150–300 ms; a leading-edge call keeps the first result instant). |
| [layout-animation](src/patterns/layout-animation.ts) | render | `/ :: click button:has-text("Save")`<br>`render.layoutCount` | 38 | 2 | −95% (19×) | Animate transform (and opacity) only, e.g. translateX(), or use a CSS animation on transform. |
| [layout-thrash](src/patterns/layout-thrash.ts) | render | `/ :: click button:has-text("Grow rows")`<br>`render.layoutCount` | 200 | 1 | −99.5% (200×) | Batch the reads, then the writes (or use requestAnimationFrame / fastdom). |
| [listener-leak](src/patterns/listener-leak.ts) | memory | `/ :: click button:has-text("Refresh widget")`<br>`memory.listenersDelta` | 20 | 0 | −100% (∞×) | Return a teardown from mount (removeEventListener, or an AbortController signal) and call it before re-rendering. |
| [long-task-click](src/patterns/long-task-click.ts) | main-thread | `/ :: click button:has-text("Compute checksum")`<br>`cpu.blockingMs` | 266 | 0 | −100% (∞×) | Split the work into slices under ~50 ms and yield between them (scheduler.yield(), or setTimeout 0). |
| [n-plus-one](src/patterns/n-plus-one.ts) | network | `/ :: load`<br>`network.requestCount` | 22 | 2 | −91% (11×) | Batch the details into the list request (?include=details, a batch endpoint, or GraphQL/DataLoader). |
| [oversized-image](src/patterns/oversized-image.ts) | network | `/ :: load`<br>`network.encodedKB` | 23387 | 1472 | −94% (16×) | Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format. |
| [request-waterfall](src/patterns/request-waterfall.ts) | network | `/ :: load`<br>`network.waves` | 5 | 2 | −60% (2.5×) | Start independent requests together (Promise.all), or have the server return them in one response. |
| [retry-storm](src/patterns/retry-storm.ts) | chaos | `/ :: load`<br>`network.requestCount`<br>under `api-503` | 22 | 4 | −82% (5.5×) | Cap retries and back off exponentially (with jitter in production). |
| [uncompressed-bundle](src/patterns/uncompressed-bundle.ts) | network | `/ :: load`<br>`network.encodedKB` | 294 | 12.2 | −96% (24×) | Serve text assets compressed (Content-Encoding: gzip or br), at the server, CDN or build step. |
| [unthrottled-scroll](src/patterns/unthrottled-scroll.ts) | main-thread | `/ :: click button:has-text("Skim the feed")`<br>`render.layoutCount` | 121 | 0 | −100% (∞×) | Use a passive listener that coalesces to one requestAnimationFrame update, and an IntersectionObserver for visibility. |
| [waterfall-amplifies-delay](src/patterns/waterfall-amplifies-delay.ts) | chaos | `/ :: load`<br>`network.settledMs`<br>under `api-delay-300` | 940 | 328 | −65% (2.9×) | Start independent requests together (Promise.all), and only chain the ones that really need a previous result. |
<!-- results:end -->

## Layout

| File | What it is |
|---|---|
| `src/pattern.ts` | the `Pattern` type and the route helpers (`html`, `json`, `handler`, `page`) |
| `src/patterns/<id>.ts` | one pattern each; discovered automatically |
| `src/server.ts` | serves one variant on an ephemeral port (each variant its own server, same paths, so perfKeys match) |
| `src/registry.ts` | `loadPatterns()`: reads `src/patterns/*.ts` and imports each one |
| `src/measure.ts` | `measurePattern()`: N seeded crawls per variant, metric medians, improvement |
| `patterns.e2e.test.ts` | the assertions, per pattern |
| `scripts/report.ts` | fills the table above |

## Adding a pattern

1. Copy `src/patterns/layout-thrash.ts` (or `retry-storm.ts` for a fault-driven
   one) to `src/patterns/<your-id>.ts`; `id` must equal the file name.
2. Write `routes(variant)`: the same paths for both variants, differing only
   in the anti-pattern. Pages are HTML strings (`page(title, body, head)`);
   API routes are `json(body, { delayMs, status })`, or `handler()` for
   anything else.
3. Set `crawl` so the crawl reliably reaches the step: a fixed `seed`, small
   `maxPages` / `maxActionsPerPage`, `actionWeights: { scroll: 0 }` for a
   click-only page, and `faults` for a chaos pattern.
4. Set `expect`: the perfKey glob, the metric path, and a `minImprovement`
   well inside the effect you built.
5. Run `PATTERN=<your-id> pnpm test` twice, then `PATTERN=<your-id> pnpm report`.

No registration step: the registry imports every `.ts` file in
`src/patterns/` (files starting with `_` are skipped).

### Pitfalls

- **Build large effects.** CI runners are shared and noisy. Aim for 10× or
  more between variants (200 layouts vs 1, 22 requests vs 4), and set the
  threshold well inside it.
- **Pick a metric that counts the work, not the wait.** `durationMs` under the
  `networkidle` settle is mostly the crawler's 500 ms quiet window. Prefer
  `render.layoutCount`, `render.scriptMs`, `render.recalcStyleMs`,
  `cpu.blockingMs`, `network.requestCount`, `network.busyMs` and
  `network.settledMs` (or `effectiveMs` = `max(durationMs, settledMs)`).
- **`blockingMs` reads 0 until a task passes 50 ms**, then jumps by the whole
  task. The layout-thrash handler forces 200 layouts yet stays under that
  line on a fast machine, so it is gated on `layoutCount`, which is exact.
  Use `render.scriptMs` for CPU work that scales smoothly.
- **Settle mode decides what is inside a span.** Crawls default to
  `settle: "adaptive"` (100 ms quiet window). Work that resumes after a longer
  gap (a backoff timer) falls outside the span, so it would not be counted and
  the fix would look better than it is. `retry-storm` uses `"networkidle"`
  (500 ms window) so its backed-off retries stay in the load span.
- **A fault at probability 1 leaves no clean span**, so
  `CrawlReport.perf.degradation` has nothing to compare it with and is empty.
  For a `degradation.*` metric, use a probability between 0 and 1, or a key
  the crawl repeats with a `schedule`.
- **Keys contain the selector**, e.g. `/ :: click button:has-text("Grow rows")`.
  Glob it (`/ :: click *`) unless the page has several controls.
- **The default action loop picks from the targets it collected when the page
  loaded.** A control that appears later (after a fetch) is never clicked
  unless the pattern sets a `driver`.
- **INP is rarely present** on clicks that navigate, and `interaction` often
  lands after the span; do not gate on `interaction.*`.
- **Memory trends need `perf: { memory: { forceGc: true } }`**; without the
  forced GC, garbage reads as a leak.
- **`page.evaluate` busy loops are not long tasks.** Put the work in the
  page's own handlers or timers.
- **Timers are not waited for.** Neither settle mode waits for a pending
  `setTimeout`. Under adaptive, the quiet window counts from the page's last
  network activity, which may be the load, not the click. Under
  `networkidle`, `waitForLoadState` returns at once after a click that does
  not navigate. So a trailing-only debounce's request lands outside the
  click's span. `input-no-debounce` uses a leading + trailing debounce so the
  fixed variant's first request stays in the span.
- **The crawler's own actions dispatch one event.** Its fill action is one
  `element.fill()`, which fires a single `input` event, and its scroll action
  is one `scrollTo`, which fires one coalesced `scroll` event. A pattern about
  per-keystroke or per-scroll work needs a button that replays the events in
  the page (`input-no-debounce`, `unthrottled-scroll`).
- **A fix that aborts a request adds a `net::ERR_ABORTED` error cluster**,
  which the "no new error clusters" check would flag. `hang-no-timeout` sets
  `options.ignoreErrorPatterns: ["net::ERR_ABORTED"]` on both variants.
- **Prefer a long `faults.delay` to `faults.hang`.** A hang holds the load span
  until the 30 s page timeout, so every crawl takes 30 s and `effectiveMs` is
  just the cap.
- **Only span metrics can be gated.** Page-level numbers (CLS in
  `perfPage.vitals`, and lightbringer's oversized-image and uncompressed flags,
  which only reach the per-page report on disk) are not readable by
  `measure.ts` yet. That is why there is no CLS pattern, and why the image and
  bundle patterns gate on `network.encodedKB`.
- `tsx` is fine for scripts here: chaosbringer is imported from its built
  `dist`, so the functions it passes to `page.evaluate` are plain JS.
