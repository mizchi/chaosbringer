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
values. A `page.` metric is one value per page visit whose load key matches.
"also" lines are further metrics the pattern asserts on the same key.

<!-- results:start -->
Medians over 3 crawls per variant at the pattern's seed; measured by `pnpm report` on 2026-09-26.

| pattern | category | what chaosbringer flags (perfKey · metric) | slow | fixed | improvement | fix |
|---|---|---|---|---|---|---|
| [cls-late-content](src/patterns/cls-late-content.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.2 | 0 | −100% (∞×) | Reserve the slot's space before the content arrives (min-height or aspect-ratio on the container, or a skeleton of the same size). |
| [duplicate-fetch](src/patterns/duplicate-fetch.ts) | network | `/ :: load`<br>`network.requestCount` | 4 | 2 | −50% (2.0×) | Deduplicate: share one in-flight promise (or a request cache such as SWR / React Query / a DataLoader). |
| [expensive-selectors](src/patterns/expensive-selectors.ts) | render | `/ :: click button:has-text("Dark toolbar")`<br>`render.recalcStyleMs` | 25.3 | 0.2 | −99.4% (168×) | Toggle the class on the element that changes and scope rules to it (or use CSS custom properties); avoid universal/:has() rules keyed off <body>. |
| [full-rerender-list](src/patterns/full-rerender-list.ts) | render | `/ :: click button:has-text("Complete next task")`<br>`render.layoutMs`<br>also `render.scriptMs`: 28.8 → 1.1, −96% (26×) | 51.4 | 1.4 | −97% (37×) | Update only what changed: touch the one row's DOM, or render through a keyed diff (React/Vue/lit keys, a virtual list) so unchanged rows are kept. |
| [hang-no-timeout](src/patterns/hang-no-timeout.ts) | chaos | `/ :: load`<br>`effectiveMs`<br>under `slow-6s` | 6128 | 1123 | −82% (5.5×) | Put a deadline on the request (AbortController / AbortSignal.timeout) and show a fallback with a retry. |
| [huge-dom](src/patterns/huge-dom.ts) | render | `/ :: load`<br>`render.nodes` | 60055 | 655 | −99% (92×) | Paginate or virtualise the list: render only the rows in view (here one page of 50). |
| [input-no-debounce](src/patterns/input-no-debounce.ts) | network | `/ :: click button:has-text("Type a query")`<br>`network.requestCount` | 20 | 2 | −90% (10×) | Debounce the input handler (~150–300 ms; a leading-edge call keeps the first result instant). |
| [late-discovered-lcp](src/patterns/late-discovered-lcp.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 760 | 140 | −82% (5.4×) | Make the LCP image discoverable from the HTML: an <img> (with fetchpriority="high"), or <link rel="preload" as="image"> plus the background rule inline in the critical CSS. |
| [layout-animation](src/patterns/layout-animation.ts) | render | `/ :: click button:has-text("Save")`<br>`render.layoutCount` | 38 | 2 | −95% (19×) | Animate transform (and opacity) only, e.g. translateX(), or use a CSS animation on transform. |
| [layout-thrash](src/patterns/layout-thrash.ts) | render | `/ :: click button:has-text("Grow rows")`<br>`render.layoutCount` | 200 | 1 | −99.5% (200×) | Batch the reads, then the writes (or use requestAnimationFrame / fastdom). |
| [lcp-lazy-hero](src/patterns/lcp-lazy-hero.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 876 | 44 | −95% (20×) | Never lazy-load the LCP image: load it eagerly with fetchpriority="high" (or preload it), and put loading="lazy" on the below-the-fold images instead. |
| [listener-leak](src/patterns/listener-leak.ts) | memory | `/ :: click button:has-text("Refresh widget")`<br>`memory.listenersDelta` | 20 | 0 | −100% (∞×) | Return a teardown from mount (removeEventListener, or an AbortController signal) and call it before re-rendering. |
| [long-task-click](src/patterns/long-task-click.ts) | main-thread | `/ :: click button:has-text("Compute checksum")`<br>`cpu.blockingMs` | 265 | 0 | −100% (∞×) | Split the work into slices under ~50 ms and yield between them (scheduler.yield(), or setTimeout 0). |
| [n-plus-one](src/patterns/n-plus-one.ts) | network | `/ :: load`<br>`network.requestCount` | 22 | 2 | −91% (11×) | Batch the details into the list request (?include=details, a batch endpoint, or GraphQL/DataLoader). |
| [no-early-flush](src/patterns/no-early-flush.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 536 | 36 | −93% (15×) | Flush the <head> and the page shell before the slow work (stream the HTML), and send the data-dependent part when it is ready, or render it client-side behind a skeleton. |
| [over-fetching-api](src/patterns/over-fetching-api.ts) | network | `/ :: click button:has-text("Show summary")`<br>`network.encodedKB` | 1384 | 10 | −99.3% (138×) | Ask for what the view needs: a sparse fieldset (?fields=id,total), a summary endpoint, or a GraphQL query; paginate long lists. |
| [oversized-image](src/patterns/oversized-image.ts) | network | `/ :: load`<br>`page.media.oversizedCount`<br>also `network.encodedKB`: 23387 → 376, −98% (62×) | 8 | 0 | −100% (∞×) | Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format. |
| [polling-spam](src/patterns/polling-spam.ts) | network | `/ :: click button:has-text("Track order")`<br>`network.requestCount` | 61.5 | 0.5 | −99.2% (123×) | Poll at the pace the data changes (seconds, not milliseconds), back off while nothing changes, pause while the tab is hidden, keep one timer; or let the server push (SSE, WebSocket, long poll). |
| [redirect-chain](src/patterns/redirect-chain.ts) | network | `/app :: load`<br>`page.vitals.TTFB.value` | 616 | 4.1 | −99.3% (150×) | Resolve defaults on the server (session, cookie, Accept-Language) and serve the page on the first request; link to the final URL; collapse unavoidable redirects into one hop. |
| [render-blocking-script](src/patterns/render-blocking-script.ts) | network | `/ :: load`<br>`page.vitals.FCP.value`<br>also `page.renderBlocking.scripts`: 1 → 0, −100% (∞×) | 432 | 36 | −92% (12×) | Load scripts with defer (or async, or type=module) and keep only what the first paint needs inline; for CSS, media queries or preload + swap for the non-critical part. |
| [request-waterfall](src/patterns/request-waterfall.ts) | network | `/ :: load`<br>`network.waves` | 5 | 2 | −60% (2.5×) | Start independent requests together (Promise.all), or have the server return them in one response. |
| [retry-storm](src/patterns/retry-storm.ts) | chaos | `/ :: load`<br>`network.requestCount`<br>under `api-503` | 22 | 4 | −82% (5.5×) | Cap retries and back off exponentially (with jitter in production). |
| [third-party-bloat](src/patterns/third-party-bloat.ts) | network | `/ :: load`<br>`page.network.thirdParty.encodedKB`<br>also `page.network.thirdParty.requestCount`: 5 → 0, −100% (∞×) | 502 | 0 | −100% (∞×) | Put a facade in front of widgets (a static button that loads the real one on click) and load the other tags on first interaction or idle; drop the ones nobody reads. |
| [uncompressed-bundle](src/patterns/uncompressed-bundle.ts) | network | `/ :: load`<br>`network.encodedKB` | 294 | 12.2 | −96% (24×) | Serve text assets compressed (Content-Encoding: gzip or br), at the server, CDN or build step. |
| [unthrottled-scroll](src/patterns/unthrottled-scroll.ts) | main-thread | `/ :: click button:has-text("Skim the feed")`<br>`render.layoutCount` | 121 | 0 | −100% (∞×) | Use a passive listener that coalesces to one requestAnimationFrame update, and an IntersectionObserver for visibility. |
| [waterfall-amplifies-delay](src/patterns/waterfall-amplifies-delay.ts) | chaos | `/ :: load`<br>`network.settledMs`<br>under `api-delay-300` | 936 | 328 | −65% (2.9×) | Start independent requests together (Promise.all), and only chain the ones that really need a previous result. |
<!-- results:end -->

## Layout

| File | What it is |
|---|---|
| `src/pattern.ts` | the `Pattern` type and the route helpers (`html`, `json`, `handler`, `page`) |
| `src/patterns/<id>.ts` | one pattern each; discovered automatically |
| `src/png.ts` | a tiny PNG encoder (seeded noise, so the file size scales with the pixels like a photo's) for image patterns |
| `src/server.ts` | serves one variant on an ephemeral port (each variant its own server, same paths, so perfKeys match), plus a `localhost` server for `thirdPartyRoutes` |
| `src/registry.ts` | `loadPatterns()`: reads `src/patterns/*.ts` and imports each one |
| `src/measure.ts` | `measurePattern()`: N seeded crawls per variant, metric medians, improvement (unit-tested in `src/measure.test.ts`) |
| `patterns.e2e.test.ts` | the assertions, per pattern |
| `scripts/report.ts` | fills the table above |

## Adding a pattern

1. Copy `src/patterns/layout-thrash.ts` (or `retry-storm.ts` for a fault-driven
   one) to `src/patterns/<your-id>.ts`; `id` must equal the file name.
2. Write `routes(variant)`: the same paths for both variants, differing only
   in the anti-pattern. Pages are HTML strings (`page(title, body, head)`);
   API routes are `json(body, { delayMs, status })`, or `handler()` for
   anything else (a redirect, streamed HTML, other headers). For resources from another company's host, put them in
   `thirdPartyRoutes(variant)`: they are served from `localhost`, a different
   registrable domain from the app's `127.0.0.1`, and the page gets that
   origin as `routes(variant, { thirdPartyOrigin })` (see `third-party-bloat`).
3. Set `crawl` so the crawl reliably reaches the step: a fixed `seed`, small
   `maxPages` / `maxActionsPerPage`, `actionWeights: { scroll: 0 }` for a
   click-only page, and `faults` for a chaos pattern.
4. Set `expect`: the perfKey glob, the metric path, and a `minImprovement`
   well inside the effect you built. The metric is one of:
   - a **span** metric, a dot path into the matching spans:
     `render.layoutCount`, `cpu.blockingMs`, `network.requestCount`,
     `network.encodedKB`, `network.settledMs`, or the derived `effectiveMs`;
   - a **degradation** metric, `degradation.<path>` into
     `CrawlReport.perf.degradation` entries for matching keys
     (`degradation.delta.effectiveMs`);
   - a **page** metric, `page.<path>` into `PageResult.perfPage` of the pages
     whose load key matches (so `key` is a load key such as `/ :: load`):
     `page.vitals.CLS.value`, `page.vitals.FCP.value`, `page.vitals.LCP.value`,
     `page.vitals.TTFB.value` (from the start of the navigation, so redirects count),
     `page.media.oversizedCount`, `page.media.uncompressedCount`,
     `page.media.imageKB`, `page.renderBlocking.scripts`,
     `page.renderBlocking.stylesheets`, `page.network.thirdParty.encodedKB`,
     `page.network.thirdParty.requestCount`, `page.network.totalEncodedKB`.
     The field list is in [the perf recipe](../../docs/recipes/perf.md).

   `alsoExpect` adds more metrics on the same key, each with its own
   `minImprovement` (e.g. `oversized-image` gates the oversized count and also
   the bytes).
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
- **Page metrics are absent, not 0, when there is nothing to report.**
  `perfPage.network.thirdParty` is left out when no request went to another
  domain, `renderBlocking` when nothing blocks, and `media` when the page
  showed no image. A fix that removes the thing entirely then has no value to
  compare, and the pattern fails as unmeasured. Set `absentAs: 0` on that
  metric (`third-party-bloat`, `render-blocking-script`). `media.oversizedCount`
  and `uncompressedCount` are a measured 0 once the page shows an image.
- **Page metrics are read when the page finishes**, from its final document.
  CLS counts every shift up to then, so late content has to land inside the
  crawl's visit: `cls-late-content` inserts its banner when a fetch answers,
  which the load span's settle waits for, rather than on a bare timer.
  `renderBlocking` is also read then: a stylesheet that the page switched to
  `media="all"` after loading (the print-media swap trick) reads as blocking.
- **The HTTP cache is off during a crawl.** The crawler routes every request
  through `page.route("**/*")` (fault injection, `traceparent`, the external
  navigation block), and Playwright disables the browser's HTTP cache on a
  page with a route. A second page load downloads an `immutable` asset again,
  exactly like a `no-store` one, so a "missing Cache-Control" pattern cannot be
  measured: both variants read the same bytes on a repeat visit, and
  `perfPage.network.fromCacheCount` stays 0. Such a pattern was tried and
  dropped.
- **`render.recalcStyleCount` counts style recalc passes, not elements.** A
  click that replaces 3000 rows reads 2–3, the same as one that changes a
  class. `full-rerender-list` gates on `render.layoutMs` and `render.scriptMs`,
  which scale with the rows.
- **A page that never goes quiet caps its spans.** Under adaptive settle, a
  click whose page keeps a request in flight at least every 100 ms (a 50 ms
  poll) closes at the 2 s action cap, so its `requestCount` is the requests of
  those 2 s. `polling-spam` counts that window: about 40 polls against 1.
- **Give the page nothing else to click when the key is a glob.** Every
  clickable thing is a candidate, checkboxes and labels included, and each
  click is a span under `/ :: click *`. `full-rerender-list` draws its check
  marks as text so the button is the only control, and every click span is
  the one the pattern is about.
- `tsx` is fine for scripts here: chaosbringer is imported from its built
  `dist`, so the functions it passes to `page.evaluate` are plain JS.
