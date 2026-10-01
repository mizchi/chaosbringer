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
PATTERN_SHARD=2/3 pnpm test        # the 2nd of 3 round-robin shards (as CI runs it)
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
Medians over 3 crawls per variant at the pattern's seed; measured by `pnpm report` on 2026-09-30.

| pattern | category | what chaosbringer flags (perfKey · metric) | slow | fixed | improvement | fix |
|---|---|---|---|---|---|---|
| [analytics-per-event](src/patterns/analytics-per-event.ts) | network | `/ :: click button:has-text("Read the article")`<br>`network.requestCount` | 121 | 2 | −98% (61×) | Queue analytics events and send them in batches (by count or on a timer), with navigator.sendBeacon (or fetch keepalive) and a final flush on visibilitychange → hidden; throttle high-frequency sources (scroll depth changes in steps, not per event). |
| [base64-inlined-assets](src/patterns/base64-inlined-assets.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.network.totalEncodedKB` | 260 | 0.8 | −99.7% (325×) | Serve shared images as files with a long-lived Cache-Control (fingerprinted names, immutable); keep data: URIs for tiny, single-use assets (a few hundred bytes), and set bundlers' inline limits accordingly. |
| [broad-mutation-observer](src/patterns/broad-mutation-observer.ts) | main-thread | `/ :: click button:has-text("Load more")`<br>`render.scriptMs` | 99.4 | 4 | −96% (25×) | Do work proportional to the change: read record.addedNodes (and filter them cheaply) instead of rescanning the document; observe the narrowest root that can change, and batch DOM insertions (a DocumentFragment is one record). |
| [cache-busting-query](src/patterns/cache-busting-query.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.network.totalEncodedKB` | 301 | 0.7 | −99.8% (430×) | Version assets by content (a content hash in the file name or query, set at build time), so the URL changes only when the file does; keep the long immutable max-age. |
| [canvas-to-dataurl-sync](src/patterns/canvas-to-dataurl-sync.ts) | main-thread | `/ :: click button:has-text("Export as WebP")`<br>`cpu.blockingMs` | 370 | 0 | −100% (∞×) | Export with canvas.toBlob() (or OffscreenCanvas.convertToBlob() in a worker) and hand the Blob to URL.createObjectURL / FormData instead of a data: URL; check per format where the browser encodes (Chromium moves WebP off the main thread, but slices PNG and JPEG on it), and do the encode in a worker when it must not touch the main thread. |
| [cls-image-no-dimensions](src/patterns/cls-image-no-dimensions.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.3 | 0 | −100% (∞×) | Give every <img> its width and height attributes (the browser derives the aspect ratio from them before the file arrives), or reserve the box with CSS aspect-ratio. |
| [cls-late-content](src/patterns/cls-late-content.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.2 | 0 | −100% (∞×) | Reserve the slot's space before the content arrives (min-height or aspect-ratio on the container, or a skeleton of the same size). |
| [console-log-heavy](src/patterns/console-log-heavy.ts) | main-thread | `/ :: click button:has-text("Recalculate cart")`<br>`render.scriptMs` | 29.4 | 1.1 | −96% (27×) | Keep console calls out of hot paths in production: a logger with levels (debug off by default), or strip them at build time (esbuild drop: ['console'], terser drop_console); log ids or small summaries rather than whole state objects. |
| [cors-preflight-per-request](src/patterns/cors-preflight-per-request.ts) | network | `/ :: load`<br>`network.settledMs`<br>also `page.network.thirdParty.requestCount`: 12 → 6, −50% (2.0×) | 323 | 64.3 | −80% (5.0×) | Keep cross-origin GETs simple: no Content-Type on a request without a body, no custom headers (put versions and flags in the query string); where headers are needed, answer preflights with Access-Control-Max-Age so repeat calls skip them, or serve the API from the page's own origin (a reverse proxy under /api). |
| [css-import-chain](src/patterns/css-import-chain.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 796 | 292 | −63% (2.7×) | Flatten the @imports: link every stylesheet from the HTML (or concatenate them at build time), so they download in parallel. |
| [detached-dom-leak](src/patterns/detached-dom-leak.ts) | memory | `/ :: click button:has-text("Open report")`<br>`memory.domNodes` | 9840 | 2835 | −71% (3.5×) | Do not hold on to removed DOM: keep the data you need to rebuild it (or a WeakRef / WeakMap keyed by live nodes), and clear caches of elements when their view unmounts. |
| [duplicate-fetch](src/patterns/duplicate-fetch.ts) | network | `/ :: load`<br>`network.requestCount` | 4 | 2 | −50% (2.0×) | Deduplicate: share one in-flight promise (or a request cache such as SWR / React Query / a DataLoader). |
| [eager-heavy-bundle](src/patterns/eager-heavy-bundle.ts) | main-thread | `/ :: load`<br>`render.scriptMs` | 48.1 | 3 | −94% (16×) | Load the feature on demand: import() it in the click handler (or on idle / when its section scrolls near), so the page load only runs the code the first view needs. |
| [eager-iframes](src/patterns/eager-iframes.ts) | network | `/ :: load`<br>`page.network.thirdParty.encodedKB`<br>also `page.network.thirdParty.requestCount`: 12 → 0, −100% (∞×) | 1481 | 0 | −100% (∞×) | Add loading="lazy" to offscreen iframes (with width and height set), or show a facade (the poster and a play button) and create the iframe on click. |
| [expensive-selectors](src/patterns/expensive-selectors.ts) | render | `/ :: click button:has-text("Dark toolbar")`<br>`render.recalcStyleMs` | 21.4 | 0.2 | −99.1% (107×) | Toggle the class on the element that changes and scope rules to it (or use CSS custom properties); avoid universal/:has() rules keyed off <body>. |
| [font-block-foit](src/patterns/font-block-foit.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 760 | 40 | −95% (19×) | Add font-display: swap (or optional) to the @font-face so the fallback paints at once; preload the font (<link rel=preload as=font crossorigin>), subset it, and self-host it on the page's origin. |
| [font-no-subset](src/patterns/font-no-subset.ts) | network | `/ :: load`<br>`network.encodedKB`<br>also `network.settledMs`: 599 → 23.8, −96% (25×) | 1090 | 6 | −99.4% (182×) | Subset fonts to the characters the site uses (pyftsubset / glyphhanger, or the font service's text= / subset options), split large scripts into unicode-range subsets the browser downloads only when a page needs them, and serve WOFF2. |
| [font-swap-cls](src/patterns/font-swap-cls.ts) | render | `/ :: load`<br>`page.vitals.CLS.value` | 0.2 | 0 | −100% (∞×) | Match the fallback to the web font: declare the fallback as an @font-face over a local() font with size-adjust, ascent-override, descent-override and line-gap-override set to the web font's metrics (next/font and Fontaine generate these), or use font-display: optional so a late font is not swapped in. |
| [full-rerender-list](src/patterns/full-rerender-list.ts) | render | `/ :: click button:has-text("Complete next task")`<br>`render.layoutMs`<br>also `render.scriptMs`: 26 → 1.3, −95% (20×) | 49.7 | 1.7 | −97% (29×) | Update only what changed: touch the one row's DOM, or render through a keyed diff (React/Vue/lit keys, a virtual list) so unchanged rows are kept. |
| [hang-no-timeout](src/patterns/hang-no-timeout.ts) | chaos | `/ :: load`<br>`effectiveMs`<br>under `slow-6s` | 6137 | 1132 | −82% (5.4×) | Put a deadline on the request (AbortController / AbortSignal.timeout) and show a fallback with a retry. |
| [huge-dom](src/patterns/huge-dom.ts) | render | `/ :: load`<br>`render.nodes` | 60055 | 655 | −99% (92×) | Paginate or virtualise the list: render only the rows in view (here one page of 50). |
| [idb-transaction-per-item](src/patterns/idb-transaction-per-item.ts) | main-thread | `/ :: click button:has-text("Sync contacts")`<br>`network.settledMs` | 778 | 171 | −78% (4.5×) | Batch writes into one transaction (put every record on one objectStore, await one oncomplete), or a few bounded chunks for very large imports; libraries such as idb / Dexie's bulkPut do this. |
| [idle-raf-loop](src/patterns/idle-raf-loop.ts) | main-thread | `/ :: load`<br>`render.scriptMs` | 62.6 | 7 | −89% (8.9×) | Drive the update from the event that changes its input (a scroll or resize listener that schedules one rAF), or an IntersectionObserver; run a rAF loop only while something animates, and stop it when it is done. |
| [inline-state-bloat](src/patterns/inline-state-bloat.ts) | network | `/ :: load`<br>`page.network.totalEncodedKB`<br>also `render.scriptMs`: 24.2 → 2.9, −88% (8.3×) | 4561 | 10.2 | −99.8% (447×) | Serialise only the state the first view renders (the visible page of results, only the fields it shows) and fetch the rest on demand from an API, paginated. |
| [inline-svg-icons](src/patterns/inline-svg-icons.ts) | render | `/ :: load`<br>`render.nodes`<br>also `network.encodedKB`: 449 → 75.2, −83% (6.0×) | 7827 | 3047 | −61% (2.6×) | Ship each icon once, as a cacheable file, and draw copies as one element each: a CSS mask-image over background: currentColor (keeps the text colour), or an <img>; an icon font does the same. A <use> sprite saves the bytes but not the DOM. |
| [innerhtml-append-loop](src/patterns/innerhtml-append-loop.ts) | main-thread | `/ :: click button:has-text("Show comments")`<br>`render.scriptMs` | 294 | 3.5 | −99% (83×) | Build the markup (or the nodes) first and insert once: join the rows' HTML and set it in one assignment or insertAdjacentHTML('beforeend', …), append nodes to a DocumentFragment, or let a framework render the list; never += on innerHTML in a loop. |
| [input-no-debounce](src/patterns/input-no-debounce.ts) | network | `/ :: click button:has-text("Type a query")`<br>`network.requestCount` | 20 | 2 | −90% (10×) | Debounce the input handler (~150–300 ms; a leading-edge call keeps the first result instant). |
| [intl-formatter-per-row](src/patterns/intl-formatter-per-row.ts) | main-thread | `/ :: click button:has-text("Show orders")`<br>`render.scriptMs` | 226 | 20.4 | −91% (11×) | Create each Intl formatter once per locale and options (a module-level constant or a small cache keyed by them) and call .format() on it; avoid toLocaleString(locale, options) in loops, which builds one per call. |
| [json-deep-clone-per-click](src/patterns/json-deep-clone-per-click.ts) | main-thread | `/ :: click button:has-text("Add to cart")`<br>`render.scriptMs` | 42.7 | 0.8 | −98% (53×) | Update immutably with structural sharing: copy only the objects on the path to the change ({ ...state, cart: { ...state.cart, items: [...items, item] } }) and keep the rest by reference; Immer's produce() does this for you. Reserve deep clones (structuredClone) for when a full copy is really needed. |
| [late-discovered-lcp](src/patterns/late-discovered-lcp.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 756 | 144 | −81% (5.3×) | Make the LCP image discoverable from the HTML: an <img> (with fetchpriority="high"), or <link rel="preload" as="image"> plus the background rule inline in the critical CSS. |
| [late-font-discovery](src/patterns/late-font-discovery.ts) | network | `/ :: load`<br>`page.vitals.LCP.value`<br>also `network.settledMs`: 843 → 422, −50% (2.0×) | 864 | 436 | −50% (2.0×) | Preload the fonts the first view needs from the HTML's <head>: <link rel=preload href=… as=font type=font/woff2 crossorigin> (crossorigin even on the same origin, or the preload is not used); keep the preloads to the one or two faces above the fold. |
| [layout-animation](src/patterns/layout-animation.ts) | render | `/ :: click button:has-text("Save")`<br>`render.layoutCount` | 38 | 2 | −95% (19×) | Animate transform (and opacity) only, e.g. translateX(), or use a CSS animation on transform. |
| [layout-thrash](src/patterns/layout-thrash.ts) | render | `/ :: click button:has-text("Grow rows")`<br>`render.layoutCount` | 200 | 1 | −99.5% (200×) | Batch the reads, then the writes (or use requestAnimationFrame / fastdom). |
| [lcp-lazy-hero](src/patterns/lcp-lazy-hero.ts) | network | `/ :: load`<br>`page.vitals.LCP.value` | 872 | 48 | −94% (18×) | Never lazy-load the LCP image: load it eagerly with fetchpriority="high" (or preload it), and put loading="lazy" on the below-the-fold images instead. |
| [listener-leak](src/patterns/listener-leak.ts) | memory | `/ :: click button:has-text("Refresh widget")`<br>`memory.listenersDelta` | 20 | 0 | −100% (∞×) | Return a teardown from mount (removeEventListener, or an AbortController signal) and call it before re-rendering. |
| [long-task-click](src/patterns/long-task-click.ts) | main-thread | `/ :: click button:has-text("Compute checksum")`<br>`cpu.blockingMs` | 268 | 0 | −100% (∞×) | Split the work into slices under ~50 ms and yield between them (scheduler.yield(), or setTimeout 0). |
| [module-import-chain](src/patterns/module-import-chain.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 856 | 248 | −71% (3.5×) | List the module graph up front with <link rel="modulepreload"> (bundlers emit these), or bundle the modules on the critical path into one file. |
| [n-plus-one](src/patterns/n-plus-one.ts) | network | `/ :: load`<br>`network.requestCount` | 22 | 2 | −91% (11×) | Batch the details into the list request (?include=details, a batch endpoint, or GraphQL/DataLoader). |
| [no-cache-headers](src/patterns/no-cache-headers.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.network.totalEncodedKB` | 301 | 0.7 | −99.8% (430×) | Serve static assets under fingerprinted names (app.3f9c1a.js) with Cache-Control: public, max-age=31536000, immutable, and keep no-cache / short max-age for the HTML only. |
| [no-early-flush](src/patterns/no-early-flush.ts) | network | `/ :: load`<br>`page.vitals.FCP.value` | 536 | 40 | −93% (13×) | Flush the <head> and the page shell before the slow work (stream the HTML), and send the data-dependent part when it is ready, or render it client-side behind a skeleton. |
| [no-event-delegation](src/patterns/no-event-delegation.ts) | memory | `/ :: load`<br>`memory.jsEventListeners` | 5033 | 37 | −99.3% (136×) | Delegate: one listener on the container that finds the row with event.target.closest() and reads its id from a data attribute (frameworks such as React already delegate at the root). |
| [no-yield-before-work](src/patterns/no-yield-before-work.ts) | main-thread | `/ :: click button:has-text("Apply filter")`<br>`interaction.maxDurationMs` | 176 | 16 | −91% (11×) | Update the UI first, then yield before the heavy work (await a requestAnimationFrame + setTimeout, or scheduler.yield()), so the next paint shows the feedback; move the work off the input's task. |
| [offscreen-render-cost](src/patterns/offscreen-render-cost.ts) | render | `/ :: load`<br>`render.layoutMs` | 145 | 16.1 | −89% (9.0×) | Put content-visibility: auto (with contain-intrinsic-size: auto <estimate>) on the page's large independent sections, so offscreen ones skip layout and paint until they scroll near; or paginate / virtualise. |
| [over-fetching-api](src/patterns/over-fetching-api.ts) | network | `/ :: click button:has-text("Show summary")`<br>`network.encodedKB` | 1384 | 10 | −99.3% (138×) | Ask for what the view needs: a sparse fieldset (?fields=id,total), a summary endpoint, or a GraphQL query; paginate long lists. |
| [oversized-image](src/patterns/oversized-image.ts) | network | `/ :: load`<br>`page.media.oversizedCount`<br>also `network.encodedKB`: 23387 → 469, −98% (50×) | 8 | 0 | −100% (∞×) | Serve images sized for the slot (a resized rendition, srcset/sizes for density), in a modern format. |
| [polling-spam](src/patterns/polling-spam.ts) | network | `/ :: click button:has-text("Track order")`<br>`network.requestCount` | 61.5 | 0.5 | −99.2% (123×) | Poll at the pace the data changes (seconds, not milliseconds), back off while nothing changes, pause while the tab is hidden, keep one timer; or let the server push (SSE, WebSocket, long poll). |
| [print-stylesheet-blocking](src/patterns/print-stylesheet-blocking.ts) | network | `/ :: load`<br>`page.vitals.FCP.value`<br>also `page.renderBlocking.stylesheets`: 1 → 0, −100% (∞×) | 436 | 44 | −90% (9.9×) | Put the media query on the <link> (media="print", or a min-width query for a breakpoint's sheet): the browser still fetches it, without blocking the screen's first paint; or fold small print rules into the main stylesheet. |
| [quadratic-dedupe](src/patterns/quadratic-dedupe.ts) | main-thread | `/ :: click button:has-text("Count visitors")`<br>`render.scriptMs` | 260 | 2.6 | −99.0% (100×) | Use a Set (or a Map / object keyed by id) for membership: new Set(ids), or seen.has(id) in the loop; the same applies to indexOf / find / filter-inside-map lookups over a growing array. |
| [redirect-chain](src/patterns/redirect-chain.ts) | network | `/app :: load`<br>`page.vitals.TTFB.value` | 617 | 4 | −99.4% (154×) | Resolve defaults on the server (session, cookie, Accept-Language) and serve the page on the first request; link to the final URL; collapse unavoidable redirects into one hop. |
| [regex-backtracking](src/patterns/regex-backtracking.ts) | main-thread | `/ :: click button:has-text("Check address")`<br>`cpu.blockingMs` | 807 | 0 | −100% (∞×) | Write the regex so each input has one way to match: no quantified group whose body can match the same text in several ways (a run, then (separator, run)*); cap the input's length before matching, and lint regexes for nested quantifiers (eslint-plugin-regexp, safe-regex). |
| [render-blocking-script](src/patterns/render-blocking-script.ts) | network | `/ :: load`<br>`page.vitals.FCP.value`<br>also `page.renderBlocking.scripts`: 1 → 0, −100% (∞×) | 436 | 36 | −92% (12×) | Load scripts with defer (or async, or type=module) and keep only what the first paint needs inline; for CSS, media queries or preload + swap for the non-critical part. |
| [render-hidden-tabs](src/patterns/render-hidden-tabs.ts) | render | `/ :: load`<br>`render.nodes`<br>also `render.scriptMs`: 18.6 → 4.2, −77% (4.4×) | 44091 | 4455 | −90% (9.9×) | Render a tab's content when it is first opened (and keep it, or unmount it, after); frameworks' lazy tab panels (Vue's v-if over v-show, React conditional rendering, <details>/hidden=until-found for text) do this. If panels must exist up front, keep them light and fill them on open. |
| [request-waterfall](src/patterns/request-waterfall.ts) | network | `/ :: load`<br>`network.waves` | 5 | 2 | −60% (2.5×) | Start independent requests together (Promise.all), or have the server return them in one response. |
| [retry-storm](src/patterns/retry-storm.ts) | chaos | `/ :: load`<br>`network.requestCount`<br>under `api-503` | 22 | 4 | −82% (5.5×) | Cap retries and back off exponentially (with jitter in production). |
| [revalidate-every-load](src/patterns/revalidate-every-load.ts) | network | `/docs/config :: load`<br>`/docs/deploy :: load`<br>`/docs/install :: load`<br>`page.vitals.FCP.value` | 332 | 28 | −92% (12×) | Give fingerprinted static assets Cache-Control: public, max-age=31536000, immutable, so repeat views use the cached copy without asking; keep no-cache for the HTML. |
| [runtime-style-injection](src/patterns/runtime-style-injection.ts) | render | `/ :: click button:has-text("Show invoices")`<br>`render.recalcStyleMs` | 187 | 19.5 | −90% (9.6×) | Extract the styles at build time (static CSS, CSS Modules, a zero-runtime CSS-in-JS such as vanilla-extract or Linaria); express per-item values as CSS custom properties or a few variant classes, not one generated rule per value. |
| [structured-clone-transfer](src/patterns/structured-clone-transfer.ts) | main-thread | `/ :: click button:has-text("Apply filter")`<br>`render.scriptMs` | 1332 | 4.3 | −99.7% (310×) | Transfer large buffers instead of copying them: postMessage(msg, [buffer]) (and the same on the reply), or structuredClone(value, { transfer }); share a SharedArrayBuffer when both sides must see the data at once (needs cross-origin isolation). |
| [sync-storage-on-input](src/patterns/sync-storage-on-input.ts) | main-thread | `/ :: click button:has-text("Type a note")`<br>`render.scriptMs` | 103 | 2 | −98% (52×) | Persist only what changed, under its own key (the draft alone), and write the rest when it changes; debounce or move large writes to idle time, or use IndexedDB (asynchronous) for big state. |
| [sync-storage-read-on-load](src/patterns/sync-storage-read-on-load.ts) | main-thread | `/app :: load`<br>`render.scriptMs` | 49.2 | 3.6 | −93% (14×) | Keep localStorage for small values: store the first screen's data (or nothing) there, put large caches in IndexedDB (asynchronous, structured, no JSON round trip) or the Cache API, and read the rest after the first render or on demand. |
| [sync-xhr-click](src/patterns/sync-xhr-click.ts) | main-thread | `/ :: click button:has-text("Check stock")`<br>`cpu.blockingMs` | 309 | 0 | −100% (∞×) | Use an asynchronous request (fetch, or XMLHttpRequest without the false flag) and render when it resolves; show a pending state meanwhile. |
| [third-party-bloat](src/patterns/third-party-bloat.ts) | network | `/ :: load`<br>`page.network.thirdParty.encodedKB`<br>also `page.network.thirdParty.requestCount`: 5 → 0, −100% (∞×) | 502 | 0 | −100% (∞×) | Put a facade in front of widgets (a static button that loads the real one on click) and load the other tags on first interaction or idle; drop the ones nobody reads. |
| [unbounded-memo-cache](src/patterns/unbounded-memo-cache.ts) | memory | `/ :: click button:has-text("Next week")`<br>`memory.jsHeapDeltaMB`<br>also `memory.jsHeapUsedMB`: 16.9 → 5.9, −65% (2.9×) | 4.4 | 0 | −100% (∞×) | Bound the cache: key it by the query's value with an LRU cap, or use a WeakMap keyed by an object whose lifetime is the view's, so entries go when their key does. |
| [unbundled-modules](src/patterns/unbundled-modules.ts) | network | `/ :: load`<br>`network.requestCount`<br>also `page.vitals.FCP.value`: 692 → 96, −86% (7.2×) | 62 | 2 | −97% (31×) | Bundle the modules for production (Vite/Rollup/esbuild), splitting by route or feature into a few chunks rather than one file per source module; HTTP/2 lifts the six-connection limit but not the per-request cost. |
| [uncompressed-bundle](src/patterns/uncompressed-bundle.ts) | network | `/ :: load`<br>`network.encodedKB` | 294 | 12.2 | −96% (24×) | Serve text assets compressed (Content-Encoding: gzip or br), at the server, CDN or build step. |
| [unthrottled-scroll](src/patterns/unthrottled-scroll.ts) | main-thread | `/ :: click button:has-text("Skim the feed")`<br>`render.layoutCount` | 121 | 0 | −100% (∞×) | Use a passive listener that coalesces to one requestAnimationFrame update, and an IntersectionObserver for visibility. |
| [unused-preload](src/patterns/unused-preload.ts) | network | `/ :: load`<br>`page.network.totalEncodedKB`<br>also `network.requestCount`: 7 → 2, −71% (3.5×) | 2423 | 287 | −88% (8.4×) | Preload only what the current page needs early and cannot discover sooner (typically the LCP image or a critical font); audit hints when the page changes (Chrome warns about a preload unused a few seconds after load). |
| [waterfall-amplifies-delay](src/patterns/waterfall-amplifies-delay.ts) | chaos | `/ :: load`<br>`network.settledMs`<br>under `api-delay-300` | 942 | 333 | −65% (2.8×) | Start independent requests together (Promise.all), and only chain the ones that really need a previous result. |
| [worker-offload](src/patterns/worker-offload.ts) | main-thread | `/ :: click button:has-text("Compute checksum")`<br>`cpu.blockingMs`<br>also `render.scriptMs`: 278 → 1.1, −99.6% (252×) | 277 | 0 | −100% (∞×) | Move DOM-free computation to a Web Worker (postMessage the input, render the result when it comes back; Comlink makes it a function call); keep the main thread for input, style, layout and paint. |
<!-- results:end -->

## What `chaosbringer scan` finds without being told

The table above is the catalog's own test: it knows each pattern's metric
and step, and compares the slow variant with the fix. [`chaosbringer
scan`](../../docs/recipes/scan.md) is what you point at a site you know
nothing about: it has only thresholds, and names the catalog entries that
match each signal. `pnpm scan-check` runs it on both variants of every
pattern and records whether the slow one is flagged with its own pattern,
and whether the fix makes the finding go away.

Two kinds of gap are expected:

- **Load-timing patterns** (`font-block-foit`, `lcp-lazy-hero`,
  `no-early-flush`, `redirect-chain`, …) are measured here on localhost,
  where LCP / FCP / TTFB never get near Web Vitals' real-world bounds. The
  catalog's own test sees them by comparing slow with fixed. A scan
  sees them on a real network, or with `--network slow-3g`.
- **A fixed variant still flagged** is a fix that improves the metric
  without getting under the threshold. For example, `inline-svg-icons`
  still has over 1,500 DOM nodes after its fix, and `full-rerender-list`
  still lays out a whole list, just once. The thresholds are for unknown
  sites, not tuned to this catalog.

The count moves by a pattern or two between runs. The timing rules read one
crawl, and a pattern whose slow variant sits near a threshold (a click that
runs 45–60 ms of script against a 50 ms bound) lands on either side of it.

<!-- scan-check:start -->
Measured by `pnpm scan-check` on 2026-10-01: one scan per variant at the pattern's seed.

**58 of 68** slow variants are flagged with their own pattern; on **48** of those, the fixed variant is not.

| pattern | slow: flagged by | fixed: still flagged by | slow: every rule that fired |
|---|---|---|---|
| [analytics-per-event](src/patterns/analytics-per-event.ts) | `chatty-action` | – | `chatty-action`, `span-layout-time` |
| [base64-inlined-assets](src/patterns/base64-inlined-assets.ts) | – | – | `request-waterfall`, `span-layout-time` |
| [broad-mutation-observer](src/patterns/broad-mutation-observer.ts) | `span-blocking`, `span-script` | – | `dom-size`, `span-blocking`, `span-script` |
| [cache-busting-query](src/patterns/cache-busting-query.ts) | `repeat-download` | – | `render-blocking`, `repeat-download`, `uncompressed-text` |
| [canvas-to-dataurl-sync](src/patterns/canvas-to-dataurl-sync.ts) | `span-blocking`, `span-interaction`, `vital-inp` | `span-blocking` | `dropped-frames`, `slow-action`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [cls-image-no-dimensions](src/patterns/cls-image-no-dimensions.ts) | `vital-cls` | – | `heavy-resource`, `vital-cls` |
| [cls-late-content](src/patterns/cls-late-content.ts) | `vital-cls` | – | `vital-cls` |
| [console-log-heavy](src/patterns/console-log-heavy.ts) | – | – | – |
| [cors-preflight-per-request](src/patterns/cors-preflight-per-request.ts) | – | – | – |
| [css-import-chain](src/patterns/css-import-chain.ts) | `request-waterfall` | `render-blocking` | `request-waterfall` |
| [detached-dom-leak](src/patterns/detached-dom-leak.ts) | `dom-size`, `memory-leak` | `dom-size` | `dom-size`, `memory-leak` |
| [duplicate-fetch](src/patterns/duplicate-fetch.ts) | `duplicate-request` | – | `duplicate-request` |
| [eager-heavy-bundle](src/patterns/eager-heavy-bundle.ts) | `span-blocking`, `span-script` | – | `span-blocking`, `span-script` |
| [eager-iframes](src/patterns/eager-iframes.ts) | `page-weight`, `third-party-heavy` | – | `page-weight`, `span-layout-time`, `third-party-heavy` |
| [expensive-selectors](src/patterns/expensive-selectors.ts) | `span-style` | – | `dom-size`, `span-blocking`, `span-layout-time`, `span-style` |
| [font-block-foit](src/patterns/font-block-foit.ts) | – | – | – |
| [font-no-subset](src/patterns/font-no-subset.ts) | `heavy-resource` | – | `heavy-resource`, `uncompressed-text` |
| [font-swap-cls](src/patterns/font-swap-cls.ts) | `vital-cls` | – | `vital-cls` |
| [full-rerender-list](src/patterns/full-rerender-list.ts) | `span-blocking`, `span-layout-time` | `span-blocking`, `span-layout-time` | `dom-size`, `span-blocking`, `span-layout-time`, `span-style` |
| [hang-no-timeout](src/patterns/hang-no-timeout.ts) | `no-request-timeout` | – | `fault-new-error`, `no-request-timeout` |
| [huge-dom](src/patterns/huge-dom.ts) | `dom-size`, `span-layout-time`, `span-style` | – | `dom-size`, `dropped-frames`, `span-blocking`, `span-layout-time`, `span-script`, `span-style` |
| [idb-transaction-per-item](src/patterns/idb-transaction-per-item.ts) | `slow-action` | `slow-action` | `many-listeners`, `slow-action`, `uncompressed-text` |
| [idle-raf-loop](src/patterns/idle-raf-loop.ts) | `span-script` | – | `span-script` |
| [inline-state-bloat](src/patterns/inline-state-bloat.ts) | `heavy-resource`, `page-weight` | – | `heavy-resource`, `page-weight`, `span-layout-time` |
| [inline-svg-icons](src/patterns/inline-svg-icons.ts) | `dom-size` | `dom-size` | `dom-size`, `span-layout-time`, `span-style` |
| [innerhtml-append-loop](src/patterns/innerhtml-append-loop.ts) | `span-blocking`, `span-interaction`, `span-script` | – | `dom-size`, `dropped-frames`, `span-blocking`, `span-interaction`, `span-layout-time`, `span-script`, `vital-inp` |
| [input-no-debounce](src/patterns/input-no-debounce.ts) | `chatty-action` | – | `chatty-action`, `memory-leak`, `slow-action` |
| [intl-formatter-per-row](src/patterns/intl-formatter-per-row.ts) | `span-blocking`, `span-interaction`, `span-script` | `span-blocking` | `dom-size`, `dropped-frames`, `span-blocking`, `span-interaction`, `span-layout-time`, `span-script`, `span-style`, `vital-inp` |
| [json-deep-clone-per-click](src/patterns/json-deep-clone-per-click.ts) | `span-blocking`, `span-script` | – | `heap-growth`, `span-blocking`, `span-script` |
| [late-discovered-lcp](src/patterns/late-discovered-lcp.ts) | `request-waterfall` | – | `heavy-resource`, `request-waterfall` |
| [late-font-discovery](src/patterns/late-font-discovery.ts) | – | – | – |
| [layout-animation](src/patterns/layout-animation.ts) | `span-layout` | – | `never-idle`, `span-layout` |
| [layout-thrash](src/patterns/layout-thrash.ts) | `span-layout`, `span-layout-time` | – | `span-layout`, `span-layout-time` |
| [lcp-lazy-hero](src/patterns/lcp-lazy-hero.ts) | – | – | `heavy-resource`, `page-weight` |
| [listener-leak](src/patterns/listener-leak.ts) | `memory-leak` | – | `memory-leak` |
| [long-task-click](src/patterns/long-task-click.ts) | `dropped-frames`, `span-blocking`, `span-interaction`, `vital-inp` | – | `dropped-frames`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [module-import-chain](src/patterns/module-import-chain.ts) | `request-waterfall` | – | `request-waterfall` |
| [n-plus-one](src/patterns/n-plus-one.ts) | `per-item-requests` | – | `per-item-requests` |
| [no-cache-headers](src/patterns/no-cache-headers.ts) | `repeat-download` | – | `render-blocking`, `repeat-download`, `uncompressed-text` |
| [no-early-flush](src/patterns/no-early-flush.ts) | – | – | – |
| [no-event-delegation](src/patterns/no-event-delegation.ts) | `many-listeners` | – | `dom-size`, `many-listeners`, `span-blocking`, `span-layout-time`, `span-style` |
| [no-yield-before-work](src/patterns/no-yield-before-work.ts) | `span-interaction`, `vital-inp` | – | `dropped-frames`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [offscreen-render-cost](src/patterns/offscreen-render-cost.ts) | `span-layout-time` | `span-layout-time` | `dom-size`, `dropped-frames`, `span-blocking`, `span-layout-time`, `span-style` |
| [over-fetching-api](src/patterns/over-fetching-api.ts) | `heavy-resource`, `page-weight` | – | `heavy-resource`, `page-weight`, `uncompressed-text` |
| [oversized-image](src/patterns/oversized-image.ts) | `heavy-resource`, `oversized-image`, `page-weight` | – | `heavy-resource`, `oversized-image`, `page-weight`, `slow-request` |
| [polling-spam](src/patterns/polling-spam.ts) | `chatty-action`, `never-idle` | – | `chatty-action`, `duplicate-request`, `never-idle`, `span-layout` |
| [print-stylesheet-blocking](src/patterns/print-stylesheet-blocking.ts) | – | – | – |
| [quadratic-dedupe](src/patterns/quadratic-dedupe.ts) | `span-blocking`, `span-script` | – | `dropped-frames`, `slow-action`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [redirect-chain](src/patterns/redirect-chain.ts) | – | – | – |
| [regex-backtracking](src/patterns/regex-backtracking.ts) | `span-blocking` | – | `dropped-frames`, `slow-action`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [render-blocking-script](src/patterns/render-blocking-script.ts) | `render-blocking` | – | `render-blocking` |
| [render-hidden-tabs](src/patterns/render-hidden-tabs.ts) | `dom-size` | `dom-size` | `dom-size`, `span-layout-time` |
| [request-waterfall](src/patterns/request-waterfall.ts) | `request-waterfall` | – | `request-waterfall` |
| [retry-storm](src/patterns/retry-storm.ts) | `fault-request-storm` | – | `fault-request-storm`, `no-request-timeout` |
| [revalidate-every-load](src/patterns/revalidate-every-load.ts) | `repeat-download` | – | `repeat-download` |
| [runtime-style-injection](src/patterns/runtime-style-injection.ts) | `span-style` | `span-style` | `dom-size`, `dropped-frames`, `memory-leak`, `span-blocking`, `span-interaction`, `span-layout-time`, `span-style`, `vital-inp` |
| [structured-clone-transfer](src/patterns/structured-clone-transfer.ts) | `span-blocking`, `span-script` | – | `dropped-frames`, `never-idle`, `slow-action`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [sync-storage-on-input](src/patterns/sync-storage-on-input.ts) | `span-script` | – | `span-blocking`, `span-script` |
| [sync-storage-read-on-load](src/patterns/sync-storage-read-on-load.ts) | `span-script` | – | `span-blocking`, `span-layout-time`, `span-script` |
| [sync-xhr-click](src/patterns/sync-xhr-click.ts) | `slow-action`, `span-blocking`, `span-interaction`, `vital-inp` | – | `dropped-frames`, `slow-action`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
| [third-party-bloat](src/patterns/third-party-bloat.ts) | `third-party-heavy` | – | `third-party-heavy` |
| [unbounded-memo-cache](src/patterns/unbounded-memo-cache.ts) | `memory-leak` | – | `memory-leak` |
| [unbundled-modules](src/patterns/unbundled-modules.ts) | – | – | – |
| [uncompressed-bundle](src/patterns/uncompressed-bundle.ts) | `uncompressed-text` | – | `render-blocking`, `uncompressed-text` |
| [unthrottled-scroll](src/patterns/unthrottled-scroll.ts) | `span-layout` | – | `span-layout` |
| [unused-preload](src/patterns/unused-preload.ts) | `page-weight` | – | `heavy-resource`, `page-weight`, `uncompressed-text` |
| [waterfall-amplifies-delay](src/patterns/waterfall-amplifies-delay.ts) | `request-waterfall` | – | `fault-new-error`, `no-request-timeout`, `request-waterfall` |
| [worker-offload](src/patterns/worker-offload.ts) | `span-blocking`, `span-script` | – | `dropped-frames`, `span-blocking`, `span-interaction`, `span-script`, `vital-inp` |
<!-- scan-check:end -->

## Layout

| File | What it is |
|---|---|
| `src/pattern.ts` | the `Pattern` type and the route helpers (`html`, `json`, `handler`, `page`) |
| `src/patterns/<id>.ts` | one pattern each; discovered automatically |
| `src/png.ts` | a tiny PNG encoder (seeded noise, so the file size scales with the pixels like a photo's) for image patterns |
| `src/font.ts` | a tiny TrueType encoder (box glyphs for printable ASCII, plus `extraGlyphs` distinct outlines from U+4E00 on for an unsubsetted-size font, and `ascent` / `descent` for its line height) that passes Chrome's font sanitizer, for web-font patterns |
| `src/server.ts` | serves one variant on an ephemeral port (each variant its own server, same paths, so perfKeys match), plus a `localhost` server for `thirdPartyRoutes` |
| `src/registry.ts` | `loadPatterns()`: reads `src/patterns/*.ts` and imports each one |
| `src/measure.ts` | `measurePattern()`: N seeded crawls per variant, metric medians, improvement (unit-tested in `src/measure.test.ts`) |
| `patterns.e2e.test.ts` | the assertions, per pattern |
| `scripts/report.ts` | fills the table above |
| `scripts/scan-check.ts` | runs `chaosbringer scan` on both variants of every pattern and fills the scan section |

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
  which `unused-preload` covers. The other side of it: a font's download
  starts only once the page has been styled, so a font named in a slow
  stylesheet starts after that stylesheet (`late-font-discovery` preloads it).
- **Give the page nothing else to click when the key is a glob.** Every
  clickable thing is a candidate, checkboxes and labels included, and each
  click is a span under `/ :: click *`. `full-rerender-list` draws its check
  marks as text so the button is the only control, and every click span is
  the one the pattern is about.
- **Only the page's main thread is measured.** `cpu.*`, `render.*` and the
  span's `network` come from the page's own CDP session; a dedicated
  worker's CPU time and its own `fetch`es appear nowhere (the request that
  loads the worker script does count). `worker-offload` relies on it: the
  fixed page's 300 ms of hashing still happen, off the main thread, and
  `cpu.blockingMs` / `render.scriptMs` read what the main thread is spared.
  Do not move work to a worker in a pattern whose point is to count it.
- **`<use>` copies are DOM too.** Each `<svg><use href="#icon"/></svg>`
  instantiates its `<symbol>` in a shadow tree, and `render.nodes` counts
  those copies: a sprite of four-path icons reads *more* nodes than the same
  icons inline (12,600 against 7,800 for 1,200 icons), with slower style
  recalc; it saves bytes only. `inline-svg-icons` fixes with one element per
  icon painted by a CSS mask from a cached file.
- **A stylesheet change restyles the whole page.** Adding a `<style>` (or
  editing a sheet) invalidates every element's style, so the next recalc
  costs as much as the page is large, not as the change: in
  `runtime-style-injection` the slow click's `recalcStyleMs` grew from ~90 to
  ~185 ms when the untouched archive around the new rows went from 1,500 to
  5,000 rows. Inline `style` attributes are not free either: the fixed rows'
  one inline custom property each costs ~17 ms of the ~23 ms recalc.
- **A `console.log` costs what its listeners make it cost.** lightbringer and
  Playwright both enable the CDP Runtime domain, so every console call is
  serialised with argument previews for each session, and the inspector
  keeps the logged objects alive. Crawls measure the DevTools-open cost,
  more than a visitor without DevTools pays (`console-log-heavy`).
- **The pattern server speaks HTTP/1.1, uncompressed, on localhost.** Chrome
  opens at most six connections per host, so 60 parallel requests queue in
  about ten rounds (`unbundled-modules`); bytes are the raw size (with gzip,
  repeated markup such as `inline-svg-icons`' shrinks far more); and there is
  no bandwidth, so a byte gap costs no time unless the server paces the body
  (`font-no-subset` sends 16 KB every 8 ms, ~2 MB/s, and gates
  `network.settledMs` beside the bytes).
- **`toBlob()` is off the main thread only for some formats.** In headless
  Chromium, `canvas.toBlob()` encodes WebP on a worker thread, but PNG and
  JPEG still on the main thread, in idle-time slices: no long task, and the
  same main-thread task time as `toDataURL()` (~140 ms against ~145 ms for a
  3000×2000 PNG). A `toBlob` fix for PNG would pass on `cpu.blockingMs` and
  move none of the work; `canvas-to-dataurl-sync` exports WebP.
- **A regex's first run is interpreted.** V8 executes a new regex in its
  bytecode interpreter and compiles it to machine code once it is hot, so a
  catastrophically backtracking regex costs ~850 ms on its first test and
  ~135 ms on the second (24 letters). Pooling both kinds of click blurs the
  median; `regex-backtracking` clicks once per page, so every value is a
  first run.
- **The settle waits for requests, not for IndexedDB.** Transactions commit
  off the main thread, and a span closes once the network has been quiet for
  the window, however many are still pending. `idb-transaction-per-item`
  sends an ack request after the write commits and gates
  `network.settledMs`, with a quiet window (`settle: 1200`) longer than the
  slow write, so the ack lands inside the click's span.
- **`table-layout: fixed` saves no measurable layout in Chromium.** A
  2,000 × 8 table read ~245 ms of `render.layoutMs` on load with
  `table-layout: auto` and ~230 ms with `fixed` and `<col>` widths (and the
  same with long wrapping cells): every row is laid out either way, and the
  column-width pass is a small part of it. It is not in the catalog; paginate
  or virtualise (`huge-dom`) or use `content-visibility` (`offscreen-render-cost`).
- **The browser adds a scroll event of its own.** A button that calls
  `scrollTo()` and dispatches a `scroll` event per step also gets one real,
  coalesced `scroll` event at the next frame, so 120 steps read 121 events
  (`analytics-per-event`).
- **CORS preflights are requests of their own.** CDP reports each `OPTIONS`
  preflight as a request (initiator type `preflight`), so it counts in
  `network.requestCount` and, to another origin, in
  `page.network.thirdParty.requestCount`: `cors-preflight-per-request` reads
  12 third-party requests for 6 calls. Its cost is the round trip, so the
  pattern gates `network.settledMs`, with the count beside it.
- **localStorage is read whole on first access.** Chromium loads every key
  of the origin's storage into the renderer the first time a page touches
  `localStorage`, synchronously. Moving the big value to a key of its own and
  reading only a small key saves the `JSON.parse`, not the load: an early try
  of `sync-storage-read-on-load` that kept the rest under `inbox:rest` read
  ~16–28 ms of script on load against ~40 ms, where moving it to IndexedDB
  reads ~3 ms.
- **Font metric overrides need a local font.** The fallback `@font-face` of
  `font-swap-cls` takes `src: local(...)`; if no listed font is installed,
  that face is skipped and the plain generic fallback (without the
  overrides) is used, so the fix shifts again. It lists Liberation Sans
  (which Playwright's `install-deps` installs on Linux), Arial, DejaVu Sans
  and others, and only overrides the vertical metrics
  (`ascent-override` / `descent-override` / `line-gap-override`), which fix
  the line height whatever the local font is; its lines are short, so the
  fonts' different widths move nothing.
- **`display: none` content is still DOM.** It is not laid out
  (`render.layoutMs` of `render-hidden-tabs` is the same on both variants),
  but building it costs script and `render.nodes` counts every node, which
  is what that pattern gates.
- **`document.write` of a script is just a parser-blocking script here.**
  Chrome's intervention against `document.write('<script src>')` applies only
  to cross-site scripts on slow (2G-like) connections, so on the pattern
  server it behaves exactly like a plain `<script src>` in `<head>`: FCP
  ~440 ms against ~36 ms, and lightbringer lists it in `renderBlocking`. It is
  not in the catalog, `render-blocking-script` covers it.
- `tsx` is fine for scripts here: chaosbringer is imported from its built
  `dist`, so the functions it passes to `page.evaluate` are plain JS.
