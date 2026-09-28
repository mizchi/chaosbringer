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
Medians over 3 crawls per variant at the pattern's seed; measured by `pnpm report` on 2026-09-27.

| pattern | category | what chaosbringer flags (perfKey · metric) | slow | fixed | improvement | fix |
|---|---|---|---|---|---|---|
| [cache-busting-query](src/patterns/cache-busting-query.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.network.totalEncodedKB` | 301 | 0.7 | −99.8% (430×) | Version assets by content (a content hash in the file name or query, set at build time), so the URL changes only when the file does; keep the long immutable max-age. |
| [cls-image-no-dimensions](src/patterns/cls-image-no-dimensions.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.3 | 0 | −100% (∞×) | Give every <img> its width and height attributes (the browser derives the aspect ratio from them before the file arrives), or reserve the box with CSS aspect-ratio. |
| [cls-late-content](src/patterns/cls-late-content.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.2 | 0 | −100% (∞×) | Reserve the slot's space before the content arrives (min-height or aspect-ratio on the container, or a skeleton of the same size). |
| [css-import-chain](src/patterns/css-import-chain.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 800 | 296 | −63% (2.7×) | Flatten the @imports: link every stylesheet from the HTML (or concatenate them at build time), so they download in parallel. |
| [detached-dom-leak](src/patterns/detached-dom-leak.ts) | memory | `/ :: click button:has-text("Open report")`<br>`memory.domNodes` | 9840 | 2835 | −71% (3.5×) | Do not hold on to removed DOM: keep the data you need to rebuild it (or a WeakRef / WeakMap keyed by live nodes), and clear caches of elements when their view unmounts. |
| [duplicate-fetch](src/patterns/duplicate-fetch.ts) | network | `/ :: load`<br>`network.requestCount` | 4 | 2 | −50% (2.0×) | Deduplicate: share one in-flight promise (or a request cache such as SWR / React Query / a DataLoader). |
| [eager-heavy-bundle](src/patterns/eager-heavy-bundle.ts) | main-thread | `/ :: load`<br>`render.scriptMs` | 48.9 | 3 | −94% (16×) | Load the feature on demand: import() it in the click handler (or on idle / when its section scrolls near), so the page load only runs the code the first view needs. |
| [eager-iframes](src/patterns/eager-iframes.ts) | network | `/ :: load`<br>`page.network.thirdParty.encodedKB`<br>also `page.network.thirdParty.requestCount`: 12 → 0, −100% (∞×) | 1481 | 0 | −100% (∞×) | Add loading="lazy" to offscreen iframes (with width and height set), or show a facade (the poster and a play button) and create the iframe on click. |
| [expensive-selectors](src/patterns/expensive-selectors.ts) | render | `/ :: click button:has-text("Dark toolbar")`<br>`render.recalcStyleMs` | 34.6 | 0.2 | −99.4% (173×) | Toggle the class on the element that changes and scope rules to it (or use CSS custom properties); avoid universal/:has() rules keyed off <body>. |
| [font-block-foit](src/patterns/font-block-foit.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 764 | 44 | −94% (17×) | Add font-display: swap (or optional) to the @font-face so the fallback paints at once; preload the font (<link rel=preload as=font crossorigin>), subset it, and self-host it on the page's origin. |
| [full-rerender-list](src/patterns/full-rerender-list.ts) | render | `/ :: click button:has-text("Complete next task")`<br>`render.layoutMs`<br>also `render.scriptMs`: 32.3 → 1, −97% (32×) | 78.3 | 1.9 | −98% (41×) | Update only what changed: touch the one row's DOM, or render through a keyed diff (React/Vue/lit keys, a virtual list) so unchanged rows are kept. |
| [hang-no-timeout](src/patterns/hang-no-timeout.ts) | chaos | `/ :: load`<br>`effectiveMs`<br>under `slow-6s` | 6144 | 1129 | −82% (5.4×) | Put a deadline on the request (AbortController / AbortSignal.timeout) and show a fallback with a retry. |
| [huge-dom](src/patterns/huge-dom.ts) | render | `/ :: load`<br>`render.nodes` | 60055 | 655 | −99% (92×) | Paginate or virtualise the list: render only the rows in view (here one page of 50). |
| [idle-raf-loop](src/patterns/idle-raf-loop.ts) | main-thread | `/ :: load`<br>`render.scriptMs` | 85.6 | 9.7 | −89% (8.8×) | Drive the update from the event that changes its input (a scroll or resize listener that schedules one rAF), or an IntersectionObserver; run a rAF loop only while something animates, and stop it when it is done. |
| [inline-state-bloat](src/patterns/inline-state-bloat.ts) | network | `/ :: load`<br>`page.network.totalEncodedKB`<br>also `render.scriptMs`: 9.9 → 3, −70% (3.3×) | 1517 | 10.2 | −99.3% (149×) | Serialise only the state the first view renders (the visible page of results, only the fields it shows) and fetch the rest on demand from an API, paginated. |
| [input-no-debounce](src/patterns/input-no-debounce.ts) | network | `/ :: click button:has-text("Type a query")`<br>`network.requestCount` | 20 | 2 | −90% (10×) | Debounce the input handler (~150–300 ms; a leading-edge call keeps the first result instant). |
| [late-discovered-lcp](src/patterns/late-discovered-lcp.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 752 | 140 | −81% (5.4×) | Make the LCP image discoverable from the HTML: an <img> (with fetchpriority="high"), or <link rel="preload" as="image"> plus the background rule inline in the critical CSS. |
| [layout-animation](src/patterns/layout-animation.ts) | render | `/ :: click button:has-text("Save")`<br>`render.layoutCount` | 38 | 2 | −95% (19×) | Animate transform (and opacity) only, e.g. translateX(), or use a CSS animation on transform. |
| [layout-thrash](src/patterns/layout-thrash.ts) | render | `/ :: click button:has-text("Grow rows")`<br>`render.layoutCount` | 200 | 1 | −99.5% (200×) | Batch the reads, then the writes (or use requestAnimationFrame / fastdom). |
| [lcp-lazy-hero](src/patterns/lcp-lazy-hero.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 864 | 72 | −92% (12×) | Never lazy-load the LCP image: load it eagerly with fetchpriority="high" (or preload it), and put loading="lazy" on the below-the-fold images instead. |
| [listener-leak](src/patterns/listener-leak.ts) | memory | `/ :: click button:has-text("Refresh widget")`<br>`memory.listenersDelta` | 20 | 0 | −100% (∞×) | Return a teardown from mount (removeEventListener, or an AbortController signal) and call it before re-rendering. |
| [long-task-click](src/patterns/long-task-click.ts) | main-thread | `/ :: click button:has-text("Compute checksum")`<br>`cpu.blockingMs` | 310 | 0 | −100% (∞×) | Split the work into slices under ~50 ms and yield between them (scheduler.yield(), or setTimeout 0). |
| [module-import-chain](src/patterns/module-import-chain.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 852 | 244 | −71% (3.5×) | List the module graph up front with <link rel="modulepreload"> (bundlers emit these), or bundle the modules on the critical path into one file. |
| [n-plus-one](src/patterns/n-plus-one.ts) | network | `/ :: load`<br>`network.requestCount` | 22 | 2 | −91% (11×) | Batch the details into the list request (?include=details, a batch endpoint, or GraphQL/DataLoader). |
| [no-cache-headers](src/patterns/no-cache-headers.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.network.totalEncodedKB` | 301 | 0.7 | −99.8% (430×) | Serve static assets under fingerprinted names (app.3f9c1a.js) with Cache-Control: public, max-age=31536000, immutable, and keep no-cache / short max-age for the HTML only. |
| [no-early-flush](src/patterns/no-early-flush.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 532 | 40 | −92% (13×) | Flush the <head> and the page shell before the slow work (stream the HTML), and send the data-dependent part when it is ready, or render it client-side behind a skeleton. |
| [no-yield-before-work](src/patterns/no-yield-before-work.ts) | main-thread | `/ :: click button:has-text("Apply filter")`<br>`interaction.maxDurationMs` | 184 | 16 | −91% (12×) | Update the UI first, then yield before the heavy work (await a requestAnimationFrame + setTimeout, or scheduler.yield()), so the next paint shows the feedback; move the work off the input's task. |
| [offscreen-render-cost](src/patterns/offscreen-render-cost.ts) | render | `/ :: load`<br>`render.layoutMs` | 151 | 14.4 | −90% (10×) | Put content-visibility: auto (with contain-intrinsic-size: auto <estimate>) on the page's large independent sections, so offscreen ones skip layout and paint until they scroll near; or paginate / virtualise. |
| [over-fetching-api](src/patterns/over-fetching-api.ts) | network | `/ :: click button:has-text("Show summary")`<br>`network.encodedKB` | 1384 | 10 | −99.3% (138×) | Ask for what the view needs: a sparse fieldset (?fields=id,total), a summary endpoint, or a GraphQL query; paginate long lists. |
| [oversized-image](src/patterns/oversized-image.ts) | network | `/ :: load`<br>`page.media.oversizedCount`<br>also `network.encodedKB`: 23387 → 376, −98% (62×) | 8 | 0 | −100% (∞×) | Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format. |
| [polling-spam](src/patterns/polling-spam.ts) | network | `/ :: click button:has-text("Track order")`<br>`network.requestCount` | 61.5 | 0.5 | −99.2% (123×) | Poll at the pace the data changes (seconds, not milliseconds), back off while nothing changes, pause while the tab is hidden, keep one timer; or let the server push (SSE, WebSocket, long poll). |
| [redirect-chain](src/patterns/redirect-chain.ts) | network | `/app :: load`<br>`page.vitals.TTFB.value` | 633 | 5.6 | −99.1% (113×) | Resolve defaults on the server (session, cookie, Accept-Language) and serve the page on the first request; link to the final URL; collapse unavoidable redirects into one hop. |
| [render-blocking-script](src/patterns/render-blocking-script.ts) | network | `/ :: load`<br>`page.vitals.FCP.value`<br>also `page.renderBlocking.scripts`: 1 → 0, −100% (∞×) | 456 | 44 | −90% (10×) | Load scripts with defer (or async, or type=module) and keep only what the first paint needs inline; for CSS, media queries or preload + swap for the non-critical part. |
| [request-waterfall](src/patterns/request-waterfall.ts) | network | `/ :: load`<br>`network.waves` | 5 | 2 | −60% (2.5×) | Start independent requests together (Promise.all), or have the server return them in one response. |
| [retry-storm](src/patterns/retry-storm.ts) | chaos | `/ :: load`<br>`network.requestCount`<br>under `api-503` | 22 | 4 | −82% (5.5×) | Cap retries and back off exponentially (with jitter in production). |
| [revalidate-every-load](src/patterns/revalidate-every-load.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.vitals.FCP.value` | 336 | 28 | −92% (12×) | Give fingerprinted static assets Cache-Control: public, max-age=31536000, immutable, so repeat views use the cached copy without asking; keep no-cache for the HTML. |
| [sync-storage-on-input](src/patterns/sync-storage-on-input.ts) | main-thread | `/ :: click button:has-text("Type a note")`<br>`render.scriptMs` | 117 | 1.7 | −99% (69×) | Persist only what changed, under its own key (the draft alone), and write the rest when it changes; debounce or move large writes to idle time, or use IndexedDB (asynchronous) for big state. |
| [sync-xhr-click](src/patterns/sync-xhr-click.ts) | main-thread | `/ :: click button:has-text("Check stock")`<br>`cpu.blockingMs` | 307 | 0 | −100% (∞×) | Use an asynchronous request (fetch, or XMLHttpRequest without the false flag) and render when it resolves; show a pending state meanwhile. |
| [third-party-bloat](src/patterns/third-party-bloat.ts) | network | `/ :: load`<br>`page.network.thirdParty.encodedKB`<br>also `page.network.thirdParty.requestCount`: 5 → 0, −100% (∞×) | 502 | 0 | −100% (∞×) | Put a facade in front of widgets (a static button that loads the real one on click) and load the other tags on first interaction or idle; drop the ones nobody reads. |
| [unbounded-memo-cache](src/patterns/unbounded-memo-cache.ts) | memory | `/ :: click button:has-text("Next week")`<br>`memory.jsHeapDeltaMB`<br>also `memory.jsHeapUsedMB`: 16.9 → 5.9, −65% (2.9×) | 4.4 | 0 | −100% (∞×) | Bound the cache: key it by the query's value with an LRU cap, or use a WeakMap keyed by an object whose lifetime is the view's, so entries go when their key does. |
| [uncompressed-bundle](src/patterns/uncompressed-bundle.ts) | network | `/ :: load`<br>`network.encodedKB` | 294 | 12.2 | −96% (24×) | Serve text assets compressed (Content-Encoding: gzip or br), at the server, CDN or build step. |
| [unthrottled-scroll](src/patterns/unthrottled-scroll.ts) | main-thread | `/ :: click button:has-text("Skim the feed")`<br>`render.layoutCount` | 121 | 0 | −100% (∞×) | Use a passive listener that coalesces to one requestAnimationFrame update, and an IntersectionObserver for visibility. |
| [unused-preload](src/patterns/unused-preload.ts) | network | `/ :: load`<br>`page.network.totalEncodedKB`<br>also `network.requestCount`: 7 → 2, −71% (3.5×) | 2423 | 287 | −88% (8.4×) | Preload only what the current page needs early and cannot discover sooner (typically the LCP image or a critical font); audit hints when the page changes (Chrome warns about a preload unused a few seconds after load). |
| [waterfall-amplifies-delay](src/patterns/waterfall-amplifies-delay.ts) | chaos | `/ :: load`<br>`network.settledMs`<br>under `api-delay-300` | 942 | 326 | −65% (2.9×) | Start independent requests together (Promise.all), and only chain the ones that really need a previous result. |
<!-- results:end -->

## Layout

| File | What it is |
|---|---|
| `src/pattern.ts` | the `Pattern` type and the route helpers (`html`, `json`, `handler`, `page`) |
| `src/patterns/<id>.ts` | one pattern each; discovered automatically |
| `src/png.ts` | a tiny PNG encoder (seeded noise, so the file size scales with the pixels like a photo's) for image patterns |
| `src/font.ts` | a tiny TrueType encoder (box glyphs for printable ASCII) that passes Chrome's font sanitizer, for web-font patterns |
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
   the bytes). `absentAs` gives the value of a page or span that left the
   field out (see the pitfalls on absent metrics).
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
- **`interaction` is read when the page finishes, and only exists from 16 ms.**
  The browser reports an interaction after the paint that ends it, often after
  the span has closed, but the report's copy of the span is built at page end,
  so a click that stays on the page has it. It is rarely there on a click that
  navigates. Event Timing drops events under 16 ms, so a fix that paints in
  time has no `interaction` at all: `no-yield-before-work` gates
  `interaction.maxDurationMs` with `absentAs: 0`. Gate `cpu.blockingMs`
  instead when the fix removes the work rather than moving it after the paint.
- **Memory trends need `perf: { memory: { forceGc: true } }`**; without the
  forced GC, garbage reads as a leak.
- **`memory.jsHeapUsedMB` is the on-heap JS only.** Typed arrays and
  ArrayBuffers keep their bytes off-heap, so a leak made of them barely moves
  it (`memory.arrayBuffers` counts them). `unbounded-memo-cache` leaks plain
  arrays of numbers.
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
- **Metrics are absent, not 0, when there is nothing to report.**
  `perfPage.network.thirdParty` is left out when no request went to another
  domain, `renderBlocking` when nothing blocks, and `media` when the page
  showed no image. A fix that removes the thing entirely then has no value to
  compare, and the pattern fails as unmeasured. Set `absentAs: 0` on that
  metric (`third-party-bloat`, `render-blocking-script`). `media.oversizedCount`
  and `uncompressedCount` are a measured 0 once the page shows an image. On a
  span metric, `absentAs` stands for a matching span without the field (a
  span without `interaction`).
- **Page metrics are read when the page finishes**, from its final document.
  CLS counts every shift up to then, so late content has to land inside the
  crawl's visit: `cls-late-content` inserts its banner when a fetch answers,
  which the load span's settle waits for, rather than on a bare timer.
  `renderBlocking` is also read then: a stylesheet that the page switched to
  `media="all"` after loading (the print-media swap trick) reads as blocking.
- **The HTTP cache is on, and shared by the pages of one crawl** (each
  crawl is a fresh browser, so runs do not share it). A page after the first
  gets a cacheable asset from cache, so measure caching on a later page's
  load key, not on the first (`no-cache-headers` gates `/docs/* :: load`, not
  `/ :: load`). Fault injection (`crawl.faults`), `traceparent` and HAR replay
  route every request through `page.route`, and Playwright disables the cache
  on a page with a route: in those crawls every page is cold, and an
  `immutable` asset is downloaded again exactly like a `no-store` one.
  External-navigation blocking, on by default, does not route and keeps the
  cache. `options: { httpCache: false }` turns it off on purpose.
- **A cache hit still counts as a request.** `page.network.totalRequests` and
  a span's `network.requestCount` include requests the memory or disk cache
  answered (they are in `fromCacheCount` as well), so caching shows in bytes
  (`totalEncodedKB`), not in request counts. A revalidation (`no-cache` +
  ETag → 304) moves only a few hundred bytes of headers, close to a real hit;
  its cost is the round trip, so `revalidate-every-load` puts the asset in
  front of first paint and gates later pages' FCP.
- **FCP fires for invisible text.** With a web font in its block period
  (`font-display` unset or `block`), Chrome lays the text out and records
  first-contentful-paint although nothing is visible yet, so FCP reads the
  same on both variants. LCP counts the text only once it shows:
  `font-block-foit` gates `page.vitals.LCP.value`.
- **`render.nodes` is read before the GC; `memory.*` after it.** With
  `forceGc`, memory fields come from a post-GC snapshot, but render deltas
  keep the pre-GC one so the GC pause does not count as render time. A click
  that builds a table and drops the old one reads +N nodes on `render.nodes`
  whether or not the old one leaks. `detached-dom-leak` gates the post-GC
  absolute `memory.domNodes`.
- **`render.recalcStyleCount` counts style recalc passes, not elements.** A
  click that replaces 3000 rows reads 2–3, the same as one that changes a
  class. `full-rerender-list` gates on `render.layoutMs` and `render.scriptMs`,
  which scale with the rows.
- **A page that never goes quiet caps its spans.** Under adaptive settle, a
  click whose page keeps a request in flight at least every 100 ms (a 50 ms
  poll) closes at the 2 s action cap, so its `requestCount` is the requests of
  those 2 s. `polling-spam` counts that window: about 40 polls against 1.
- **An idle page's span is as long as its settle window.** Work that runs by
  itself every frame (a `requestAnimationFrame` loop) is counted for as long as
  the span lasts, and under the default 100 ms quiet window a load span holds a
  few frames only. `idle-raf-loop` settles with a 1 s window (`settle: 1000`),
  some 60 frames, so the loop's cost dwarfs the fixed page's one update.
- **External-navigation blocking fails cross-origin iframes.** It pauses
  every document request, subframes included, and fails the ones to another
  origin, so an embed from `thirdPartyOrigin` never loads (its request shows
  with 0 bytes). `eager-iframes` sets `options: { blockExternalNavigation:
  false }`; the crawl has no links to follow off-site anyway.
- **Out-of-process iframes: only their network is measured.** Headless
  Chromium runs cross-site iframes in the page's process; under site isolation
  (headed Chrome, or `--site-per-process`) each is its own CDP target, and
  lightbringer attaches to those targets to count their requests (the page's
  own session sees only the iframe's document request, with 0 bytes).
  `eager-iframes` runs with `--site-per-process` so the pattern covers that
  path; it reads the same ~1,480 KB either way. An out-of-process iframe's
  long tasks, render metrics and vitals are still not measured, and the
  crawler's `network` throttling and `httpCache: false` do not reach it, so
  a CPU- or render-bound pattern must keep its work in the page's own
  document.
- **A declared web font costs nothing until text uses it.** The browser
  downloads a `@font-face` only when some text on the page is set in that
  family, weight and style, so eight declared weights of which two are used
  fetch two files. The byte cost of unused faces comes from preloading them,
  which `unused-preload` covers.
- **Give the page nothing else to click when the key is a glob.** Every
  clickable thing is a candidate, checkboxes and labels included, and each
  click is a span under `/ :: click *`. `full-rerender-list` draws its check
  marks as text so the button is the only control, and every click span is
  the one the pattern is about.
- `tsx` is fine for scripts here: chaosbringer is imported from its built
  `dist`, so the functions it passes to `page.evaluate` are plain JS.
