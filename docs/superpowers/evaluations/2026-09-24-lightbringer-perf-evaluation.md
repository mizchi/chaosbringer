# lightbringer-in-chaosbringer: Exploratory Performance Evaluation

**Date:** 2026-09-24
**Project:** chaosbringer
**Status:** Exploratory evaluation of the absorbed perf layer (Phases 0–3 plus the refactor) at commit `19af79a`, which is merged `main` after PR #153. No code changes.
**Design under test:** `docs/superpowers/specs/2026-09-23-lightbringer-absorption-design.md`

**Goal:** Measure what the perf layer costs, whether it finds real problems, and where its numbers mislead. The layer covers `--perf`, `--perf-trace`, `--perf-mem`, `--perf-cov`, `--settle adaptive`, `scenarioLoad` + `perf`, perf under fault injection, and `perfSeekingDriver`. All seven planned experiments (E1–E7) ran. E2b was added after review to test whether settle modes miss late async errors.

**Raw data:** The raw data was kept in the evaluation scratch directory and was not committed. Experiment directories are referred to by their names: `E1-overhead`, `E2-settle`, `E2b-late-errors`, `E3-hotspots`, `E4-chaos`, `E5-leaks-coverage`, `E6-load` and `E7-perf-seeking`.

---

## 1. Summary

1. **The `--perf`, `--perf-trace`, `--perf-mem` and `--perf-cov` flags never changed what a crawl found.** (`--settle adaptive` can; see item 3.)
   - 50 timed runs in E1 and 102 settle runs in E2 found the same pages, action sequences and error clusters across perf levels and reruns.
   - In E1, `perf.totals.spans` equalled pages + actions in every run.
2. **Light-level overhead is close to the docs (30 vs 25 ms per span on the fixture). Read the percentages as ranges, because the run order was fixed.**
   - `--perf` costs 30.0 ms per span on the fixture and 26.7 ms per span on playground v1. The docs' reference figure is about 4%, or 25 ms per span, on the fixture. The median cost is +5.0% and +8.0% of wall time; the worst-to-best range is +2.6% to +14.2%.
   - `--perf-cov` adds 9.0–11.9%, `--perf-mem` 11.6–18.9% and `--perf-trace` 19.9–24.0%.
   - `--perf-trace` writes 0.8–2.5 MB of trace per page visited.
   - The report JSON grows 6.6–8×.
3. **`--settle adaptive` is 2.9–3.5× faster than networkidle and gave identical results on the default-loop E2 crawls (seed 42 on 3 targets, 15/15 seed pairs). With a driver and on late async errors its results differ, so it should stay opt-in.**
   - Crawl time fell from 33.3 to 9.4 s on the fixture, 12.7 to 4.3 s on v1 and 13.3 to 4.6 s on v2.
   - Results matched networkidle at seed 42 on 3 targets and in 15 of 15 seed pairs. With a driver, adaptive also found content rendered after an XHR that networkidle missed.
   - A fixed 50 ms settle was faster still (3.4–4.4×) and matched networkidle on those crawls.
   - **E2b:** On a loads-only crawl of pages whose errors fire from timers of 150–2000 ms set during page parse, adaptive and 50 ms caught 0 of 5 errors in every rep. networkidle caught 3 of 5 (150 ms, 300 ms, and the rejection at 500 ms), and 250 ms caught 1.
   - **Recommendation:** Adaptive suits perf and `perf regress` crawls and driver crawls. For hunting late async errors, use networkidle or a longer fixed settle.
4. **Both seeded slowdowns were found on the right metric.**
   - v2's 120 ms server sleep shows as `/api/users :: load` with `network.busyMs` 6.2 → 127.5.
   - The 150 ms busy loop on `/users` reads `blockingMs` = 150 in 10 of 10 runs.
   - `perf regress` flags both slowdowns in both settle modes. On null splits (the same build split into two groups of runs) it reported 0 false regressions and 1 spurious "improvement".
5. **Under networkidle, span `durationMs` mostly measures the crawler's own settle wait.**
   - A load span is 529–548 ms, of which about 500 ms is networkidle's quiet window.
   - The top-ranked slowest spans are link clicks with little busy time (about 6.6 ms on v1, about 20 ms on the fixture) next to about 600 ms of duration.
   - Rank hotspots by `busyMs`, `blockingMs` and `scriptMs`, or use adaptive, which raises the v2 signal from +23% to +94%.
6. **Under faults (E4), each fault shows up where it should, with two exceptions.**
   - A 300 ms delay reads as +280 to +314 ms on every span that waits for the request (+297 to +314 under networkidle; +280 to +301 under adaptive).
   - A 503 with one client retry reads as `requestCount` +1.
   - `faults.cpu(4)` scales `scriptMs` about 4.5–5.4× (4.5–4.6× on the xhr-site keys) and turns sub-threshold work into one new long task per heavy span.
   - Exception 1: under networkidle, a delayed XHR from a click is counted in several later spans, and `degradation` reports a *negative* delta for the fault (−24 to −30 ms) (B2).
   - Exception 2: the degradation "clean" side mixes in spans that carry other faults (B11).
   - Faults draw from the crawler's seeded RNG, so conditions run at the same seed are different crawls.
7. **Leak trends need `--perf-mem`, and `--perf-mem` breaks the navigation filter.**
   - On the single-document leak and control pages, `--perf-mem` flagged 15 of 15 leaking runs and 0 of 10 non-leaking runs; without it, those 10 non-leaking runs were all false positives.
   - Across all E5 runs: with `--perf-mem`, 20 of 25 leaking runs were flagged (`/navleak` 0/5) and 5 of 30 non-leaking runs were false positives (`/chain`); without it, 10 of 30 non-leaking runs were false positives.
   - With `--perf-mem`, `documentsDelta` reads 0 on every navigation, so series that span several documents are not split. A no-leak chain of pages was flagged in 5 of 5 runs (B1, high).
8. **Under load, contention shows up as step latency, not as `blockingMs`.**
   - From 1 to 8 workers (perf on), list latency p50 rose from 40 to 72 ms and server p95 from 4 to 11 ms (13 ms with perf off).
   - Fixed in-page work read `blockingMs` 128 → 141 ms.
   - 8 workers on 4 CPUs is likely CPU-bound (inferred from 8 contexts on 4 cores; CPU utilisation was not measured).
   - Sampling one worker costs 2.8–4.8% of throughput. The sampled worker completes 0.82–0.92× the iterations of the unsampled workers.
9. **`perfSeekingDriver` helps when the cost is in click handlers.**
   - It spent 67% of steps on expensive buttons against 23% for random, and 78% when given a prior report.
   - Its action sequence reproduced on only 7 of 10 seeds.
   - It gave no measurable benefit on the playground (n = 10, underpowered).
10. **19 bugs and doc gaps were found (§12).** The main ones:
    - B1: `--perf-mem` breaks navigation detection in trends;
    - B2: in-flight requests are counted in several spans;
    - B3: crawl-wide vitals are credited to the wrong URL;
    - B4: inline scripts are merged into one coverage entry;
    - B5: `perf regress` ignores the settle mode;
    - B6: settle modes that miss late errors are undocumented.

---

## 2. Setup

| Item | Value |
|---|---|
| Code | commit `19af79a` (merged `main` after PR #153), detached worktree, run from `packages/chaosbringer/dist` |
| Versions | chaosbringer 0.10.0; lightbringer 0.3.1 (workspace); Playwright 1.59.1; Node v22.22.2; headless Chromium |
| Machine | 4 CPUs, shared; Linux 6.18 |
| Targets | fixture site; playground v1 and v2 (no `CHAOS_*` faults unless stated); v1 with `PLAYGROUND_PERF_REGRESSION=1` (150 ms busy loop on `/users`); purpose-built sites for the E2 probes, E2b, E4 (`xhr-site.mjs`), E5 and E7 |
| Scheduling | One browser workload at a time. Before each run (E1: before each repetition), a bounded wait until the 1-minute load average is below 2. |
| 1-minute load before runs | E1 0.21–1.57 · E2 0.14–1.58 · E2b 0.02–0.55 · E3 0.27–1.51 · E4 0.01–1.41 · E5 0.1–0.98 · E6 median 1.26–1.96 (gate never timed out) · E7 0.18–1.45 |
| Seeds | 42 for the timed batches (E1–E4); 1..5 for E2 parity and E5; 1 for E2b; 1..10 for E7 |
| Repeats | At least 5 per timed configuration (E4: 3), reported as median [min–max]. Exceptions are noted in each section. |
| Raw data | kept in the evaluation scratch directory (not committed), one directory per experiment |

---

## 3. E1: Overhead of the perf levels

**Method.**
- Five flag sets:
  - `off`: no perf flags;
  - `light`: `--perf`;
  - `trace`: `--perf --perf-trace --perf-out`;
  - `mem`: `--perf --perf-mem`;
  - `cov`: `--perf --perf-cov`.
- 5 repetitions per target.
- Crawl settings: `--seed 42 --max-actions 3`, plus `--max-pages 10` on the fixture (38 spans) and `--max-pages 8` on v1 (28 spans).
- Wall time was measured outside the process.
- **Order confound:** `run.sh` always ran the configs in the order off, light, trace, mem, cov, and checked the load only before `off`. No rotated rerun was done.

**Results (median [min–max], n=5)**

| target | config | wall ms | Δ median | range worst–best | Δ per span, ms | report JSON | perf-out |
|---|---|---|---|---|---|---|---|
| fixture | off | 22803 [22678–23155] | – | – | – | 16,297 B | – |
| fixture | light | 23943 [23768–24477] | +5.0% | +2.6 to +7.9% | 30.0 | 129,174 B | – |
| fixture | cov | 24859 [24783–25247] | +9.0% | +7.0 to +11.3% | 54.1 | 130,156 B | – |
| fixture | mem | 25441 [25315–25795] | +11.6% | +9.3 to +13.7% | 69.4 | 129,181 B | – |
| fixture | trace | 27333 [27144–27829] | +19.9% | +17.2 to +22.7% | 119.2 | 132,916 B | 21.0 MB |
| v1 | off | 9280 [9192–9479] | – | – | – | 9,960 B | – |
| v1 | light | 10027 [9990–10501] | +8.0% | +5.4 to +14.2% | 26.7 | 66,118 B | – |
| v1 | cov | 10382 [10173–10813] | +11.9% | +7.3 to +17.6% | 39.4 | 66,362 B | – |
| v1 | mem | 11031 [10715–11498] | +18.9% | +13.0 to +25.1% | 62.5 | 66,274 B | – |
| v1 | trace | 11508 [11210–11745] | +24.0% | +18.3 to +27.8% | 79.6 | 68,967 B | 7.7 MB |

**Cost on top of `light`**
- **Trace:**
  - The cost is mostly per page: about 339 ms per page on the fixture and about 185 ms per page on v1.
  - Each page writes one `*.trace.json` plus one small JSON.
  - Fixture trace files are 0.79–2.48 MB each: about 2.1 MB per page, or 0.55 MB per span.
  - Playground: about 0.95 MB per page.
  - The docs say "tens of MB per page", but these pages are tiny.
- **Mem:** About 36–39 ms per span, which fits two forced garbage collections at each span boundary.
- **Cov:** About 44–92 ms per page.

**Crawl results:** Nothing differed across the 25 runs per target. The check covered the pages, the action sequence, the error cluster keys and counts, and `totalErrors`.

**Interpretation**
- The overhead is real even with the order confound. On the fixture, the `off` maximum (23155 ms) is below the `light` minimum (23768 ms), and trace and mem never overlap `off` either.
- The exact percentages may still be biased by the fixed order.
- Relative cost is higher on v1 because its spans are cheaper, as the docs predict.
- Most of the report growth is per-span data, such as the top-5 request lists.

**Caveats**
- Trace was only timed together with `--perf-out`.
- The per-span figures spread per-page costs across all spans.
- The artefact sizes come from single runs.

---

## 4. E2: `--settle adaptive` vs networkidle

**Method.**
- Crawl settings: `--seed 42 --max-pages 10`, with the default 5 actions per page.
- Four settle modes (networkidle, adaptive, 50, 250), run in turn within each repetition: 5 repetitions × 3 targets.
- Then one `--perf` run per configuration, seeds 1..5 for networkidle and adaptive, and driver probes on pages where a click triggers an XHR.
- 102 runs in total, all with exit code 0.

**Wall clock (ms, median [min–max], n=5)**

| target | networkidle | adaptive | 50 | 250 | adaptive speedup | 50 ms speedup |
|---|---|---|---|---|---|---|
| fixture (10 pages / 46 actions) | 33348 [32833–33469] | 9433 [9220–9748] | 7599 [7013–7708] | 16566 [16412–16841] | 3.54× | 4.39× |
| v1 (10 / 42) | 12702 [12601–12846] | 4273 [4260–4455] | 3753 [3708–3953] | 6248 [6088–6444] | 2.97× | 3.38× |
| v2 (10 / 42) | 13315 [13254–13608] | 4635 [4486–4742] | 3955 [3782–4050] | 6617 [6556–6857] | 2.87× | 3.37× |

**Page load time and gap between actions (ms, all 5 runs pooled)**

| target | mode | loadTime p50 / p90 / max | gap between actions p50 / p90 / max |
|---|---|---|---|
| fixture | networkidle | 536 / 547 / 623 | 675 / 1261 / 1440 |
| fixture | adaptive | 133 / 150 / 159 | 171 / 353 / 512 |
| v1 | networkidle | 531 / 542 / 553 | 104 / 706 / 1360 |
| v1 | adaptive | 131 / 145 / 159 | 33 / 236 / 467 |
| v2 | networkidle | 532 / 650 / 658 | 104 / 726 / 1408 |
| v2 | adaptive | 132 / 248 / 258 | 34 / 243 / 479 |

**`--perf` spans:**
- Fixture load span median: 528 ms under networkidle, 129 ms adaptive, 78 ms at 50 ms and 284 ms at 250 ms.
- Fixture click span median: 582 ms under networkidle, 179 ms adaptive.
- No span hit the settle cap.

**Parity**
- All 12 configurations gave identical results across their 5 runs.
- At seed 42, adaptive, 50 and 250 matched networkidle exactly.
- Seeds 1..5: 15 of 15 networkidle/adaptive pairs were identical, with adaptive speedups of 2.8–3.6×.
- This parity is partly built into the crawler:
  - the default random loop picks from a target list collected once per page visit (`crawler.ts:2182`);
  - only the driver loop collects targets again before each step (`crawler.ts:2291-2292`).
- The targets are small: at most 10 pages and 1–4 error clusters.

**Driver probes**

| probe | networkidle | adaptive |
|---|---|---|
| A: click "Load", which fetches `/api/slow?ms=N` and then renders a "Rendered" button that throws; N=50 | sees "Rendered", finds the exception | sees it, finds it |
| A, N=300 | **misses it** | finds it (Load span 482 ms) |
| A, N=1000 | **misses it** | finds it (1183 ms) |
| A, N=2500 | misses it | misses it, but the step is reported as capped (2075 ms, `settleCapped: 1`) |
| C: `weightedRandomDriver`; "Show more" renders links after a 300 ms XHR; seeds 1..5 | both hidden pages reached in 1 of 5; spurious `net::ERR_ABORTED` cluster in 4 of 5 | both reached in 5 of 5; no spurious cluster |
| B: the same page, default random loop | same result as adaptive (target list never refreshed) | same |

**Interpretation**
- Networkidle adds a floor of about 500 ms to every page load.
- Adaptive follows the real work. v2's 120 ms delay shows up in its p90 (248 vs 145 ms).
- On the default loop, adaptive changes only *when* the crawler acts. With a driver, it also changes *what* it finds.
- There is no evidence that adaptive finds more than a small fixed settle on these targets. Its advantage is that perf numbers reflect app work.
- The parity claim does not extend to late async errors: adaptive missed every error delayed by 150 ms or more, and shorter delays were not tested (§5).

**Caveats**
- None of the three targets renders new controls from a click-triggered XHR.
- The playground's random actions are mostly scrolls.
- The `--perf` runs and the seed pairs were run once each.

---

## 5. E2b: Late async errors under each settle mode

**Method.**
- Target: a root page plus 5 pages whose inline scripts set timers during page parse that throw after 150, 300, 800 or 2000 ms, or reject a promise after 500 ms.
- Crawl settings: `--max-actions 0 --max-pages 6 --seed 1`.
- 5 repetitions per mode, modes interleaved, one run at a time. The load was 0.02–0.55 and the gate never waited.

| mode | wall ms, median [min–max] | load times per page, ms | late errors caught (of 5) |
|---|---|---|---|
| networkidle | 4239 [4196–4256] | 530–552 | **3** (`/late-150`, `/late-300`, `/rej-500`), in every rep |
| 250 | 2751 [2691–2819] | 277–306 | 1 (`/late-150`), in every rep |
| adaptive | 1829 [1805–1859] | 128–155 | **0**, in every rep |
| 50 | 1514 [1509–1553] | 75–106 | **0**, in every rep |

**Interpretation**
- Adaptive leaves a page once network and DOM activity go quiet. A pending `setTimeout` does not keep it on the page, so errors that fire after that point are never seen.
- No mode caught the 800 ms or 2000 ms errors.
- Crawls that perform actions stay on each page longer and may still catch some late errors. This was not measured.
- **Revised claim:** Adaptive missed every error delayed by 150 ms or more; shorter delays were not tested, so it is not known at what delay adaptive starts to keep networkidle's findings. When a crawl's purpose is to find late async errors, use networkidle or a longer fixed settle.

---

## 6. E3: Finding hotspots with `--perf`

**Method.**
- Every run used `--seed 42 --perf --perf-trace --perf-out`.
- Playground runs added `--max-pages 8 --max-actions 2 --ignore-preset analytics` (22 spans). Fixture runs used `--max-pages 10` (56 spans).
- 5 runs each on v1, v2, v1 with the regression, and the fixture. The playground runs were then repeated with `--settle adaptive`.

**Slowest keys (median [min–max], n=5)**

| app | perfKey | durationMs | busyMs | blockingMs | scriptMs |
|---|---|---|---|---|---|
| v1 | `/ :: click a:has-text("API: users")` | 619.4 [603–653] | 6.6 | 0 | 5.2 |
| v1 | `/ :: load` | 548 [541–568] | 11.6 | 0 | 6.0 |
| v2 | **`/api/users :: load`** | **653.2 [652.5–657.4]** | **127.5 [126.7–128.1]** | 0 | 6.8 |
| v2, adaptive | `/api/users :: load` | 258.1 [255–260] | 128.4 | 0 | – |
| v1 with regression | **`/users :: load`** | **686.2 [684.7–690.6]** | 5.7 | **150 [150–150]** | **156.6** |
| v1 with regression, adaptive | `/users :: load` | 296 [293–297] | – | 150 | – |
| fixture | `/ :: click "Page with network error"` | 631 [621–652] | 20.3 (2 waves) | 0 | 5.2 |

Other loads took 529–548 ms under networkidle and about 130–137 ms under adaptive. Scrolls took about 4 ms.

**`perf regress`**

| comparison | exit | regressions |
|---|---|---|
| v1 → v2, networkidle | 1 | `/api/users :: load`: `durationMs` 531.7 → 653.2 (+23%); `busyMs` 6.2 → 127.5 (+1956%) |
| v1 → v2, adaptive | 1 | same key: `durationMs` 133.2 → 258.1 (+94%); `busyMs` +1816% |
| v1 → v1 with regression, networkidle | 1 | `/users :: load` only: `durationMs` +30%; `scriptMs` 6.3 → 156.6; `blockingMs` 0 → 150; `droppedFrames` 0 → 7; `longestFrame` +694% |
| v1 → v1 with regression, adaptive | 1 | `/users :: load` only, the same five metrics; `durationMs` +161.4 ms (+120%) |
| null splits (runs 1–2 vs 3–5; v1, v2, fixture) | 0 | none. v1 reports 1 spurious improvement: `/api/users :: load` `scriptMs` 9.6 → 6.1 (−36%) |

**Interpretation**
- **Under networkidle, `durationMs` is mostly settle wait.** The top-ranked spans on v1 and the fixture are link clicks with about 6.6 ms (v1) and about 20 ms (fixture) of busy time, small next to about 600 ms of duration. They are artefacts of the wait, not hotspots. Base hotspot claims on `busyMs`, `blockingMs`, `scriptMs`, adaptive durations, or `perf regress`.
- **v2's delay** is correctly shown as network time: the worst TTFB is 126 ms and CPU is unchanged.
- **The busy loop:** the drilldown shows `(eval) /users` at 150.1 ms. Of that, 93.8 ms is own time in `/users:2` and 56.1 ms is native `now`.
- **Smaller effects:**
  - The missing image on `/network-error` adds a second request wave of about 20 ms.
  - The first page of each crawl is slower: 543–548 vs 530 ms, and LCP 60–64 vs 32.
  - One outlier (805 vs 593 ms) did not recur.
- **Absent fields:** INP, `trends`, `degradation`, `thirdParty`, `renderBlocking` and `media` were absent in every run, which is correct for these apps.

**Caveats**
- Trace was on in every run, so the absolute durations include its cost.
- The drilldowns show the slowest span of run 1, not a median.
- The CSS, media, third-party and INP code paths were not exercised.

---

## 7. E4: Perf under chaos

**Method.**
- Runs used the `chaos()` and `faults` API imported from `packages/chaosbringer/dist/index.js`, with `seed: 42` and `perf: true` at the light level. The settle was networkidle unless noted.
- 3 reps per condition, one crawl at a time, 51 run reports in total. The load was 0.01–1.41 and no rep waited at the gate.
- **Sites:**
  - **playground v1** (`--max-pages 8`, 2 actions per page). It makes no XHR calls: `/api/*` is only reached as a document navigation.
  - **fixture** (12 pages, 3 actions). Only `/api-consumer` fetches `/api/data`, once per crawl.
  - **`xhr-site.mjs`**, purpose-built for this experiment:
    - 8 `/items/:id` pages that share one perfKey;
    - each page fetches `/api/item/:id` on load and retries once if the response is not OK;
    - a "Reload" button fetches again;
    - load and a "Compute" button run a fixed-iteration loop of about 40 ms, so a CPU throttle scales it.
- **Conditions:**
  - (a) baseline, no faults;
  - (b) `faults.delay(300, {urlPattern:/\/api\//, probability:.5})`;
  - (c) `faults.status(503, {…, probability:.3})`;
  - (d) `faults.cpu(4)` at `beforeNavigation`, p=1, plus a variant at p=0.5 so that degradation has clean spans to compare against;
  - (e) playground server-side faults (`CHAOS_LATENCY_RATE=0.5 CHAOS_LATENCY_MS=300 CHAOS_5XX_RATE=0.3 CHAOS_5XX_CODE=503`) with `traceparent:true, server:{mode:"remote"}`;
  - extra: xhr-site under `settle:"adaptive"` for (a), (b) and (c).
- Values are pooled medians over all spans of a key across the 3 reps, as median (min–max), with n = number of spans. All times are in ms.

### 7.1 Delay (300 ms, p=0.5)

| site / key | baseline dur | delay: faulted spans | delay: clean spans | Δ (median) |
|---|---|---|---|---|
| xhr `/items/:id :: load` | 573.7 (568.7–604) n=24 | 874.3 (869.1–888.3) n=12 | 577.5 (569.3–588.5) n=12 | **+297** (degradation +295.9 / +297.8 / +295.8) |
| xhr `click Reload`, networkidle | 53.3 (37.1–81.4) n=30 | 52.9 (38.4–73.5) n=12 | 78.1 (45.2–86.9) n=9 | **−24 to −30** (degradation; B2) |
| xhr `click Reload`, adaptive | 159 (152–204) | 457.3 (450.4–491.3) n=12 | 177 (153–192) n=9 | **+280 to +283** |
| xhr `load`, adaptive | 181 (172–200) | 473.9 (468–479) | 176.7 (167–206) | **+293 to +301** |
| fixture `/api-consumer :: load` | 535.7 (535.1–536.1) | 835.7 (834.6–837.4) n=3 | – | **+300** (no degradation pair: key visited once) |
| playground `/api/users/:id :: load` (document) | 526.2 (526.1–529.5) | 832.9 (831.3–846.5) n=3 | – | **+307** |
| playground `/ :: click "API: users"` (navigation) | 613.9 (597–615.6) | 928 (920.5–933) n=3 | – | **+314** |

- A 300 ms delay shows up as +280 to +314 ms on every span that waits for the request: +297 to +314 on loads and navigating clicks under networkidle, +293 to +301 on adaptive loads, and +280 to +283 on XHR clicks under adaptive settle.
- It shows up only in `durationMs`. `blockingMs`, `longTaskCount`, `scriptMs`, `layoutCount` and `layoutMs` do not change; for example, xhr load `scriptMs` is 41.5 vs 43.0 and `layoutCount` 2 vs 2.
- Wall time per crawl rose from 12.6 to 15.2–15.6 s on xhr-site and from 8.7 to 9.4–9.6 s on the playground.

### 7.2 503 (p=0.3): request amplification

| site / key | baseline req | 503 faulted req | 503 clean req | Δ dur |
|---|---|---|---|---|
| xhr `load`, networkidle | 2 (2–2) | **3 (3–3)** n=6 | 2 n=18 | +48 to +55 |
| xhr `click Reload`, networkidle | 1 | 1 (1–2) n=12 | 1 | +1 to +16; `requestCount` Δ 0 |
| xhr `click Reload`, adaptive | 1 | **2 (2–2)** n=12 | 1 | +63 to +68; `requestCount` Δ **+1** |
| xhr `load`, adaptive | 2 | 3 | 2 | +44 to +46; `requestCount` Δ +1 |
| playground `/api/users/:id :: load` (document) | 1 | 1 n=3 | – | ≈0 (528 vs 526) |
| fixture | – | its only match (1 per run) never fired | – | no data |

- The xhr app's single retry shows correctly as `requestCount` +1, but only on spans the crawler waits for. Under networkidle, the retry after a click lands after the span has closed, so it shows Δ 0.
- The server's counter agrees: 14 real API hits per run, and `faultInjections` shows 23 matched and 9 injected (23 − 9 = 14).
- Document navigations that get a 503 have no retry and cost nothing extra.
- The 503 caused no long tasks. `layoutCount` rose only in the maximum (2 → 3), from rendering the error text.

### 7.3 CPU throttle ×4

| key | metric | baseline | cpu×4 | ratio |
|---|---|---|---|---|
| xhr `/items/:id :: load` | scriptMs | 41.5 (39.4–63.5) | 187.1 (170.9–210.5) | **4.5×** |
| | blockingMs | 0 (0–58) | 166 (152–183) | long tasks appear |
| | longTaskCount | 0 (0–1) | 1 (1–1) | 0 → 1 |
| | layoutMs | 6.1 (4.6–7.9) | 23.3 (18.9–27.1) | ~3.8× |
| | recalcStyleMs | 0.7 (0.6–1) | 3.5 (1.6–5.1) | ~5× |
| | durationMs | 573.7 | 785.1 (762–820) | +211 |
| xhr `click Compute` | scriptMs | 34.8 (33.6–42.1) | 159.3 (141.6–196.7) | **4.6×** |
| | blockingMs / longTaskCount | 0 / 0 | 160 (144–201) / 1 | new long task |
| | durationMs | 90.6 | 259.6 | 2.9× |
| fixture loads (e.g. `/about`) | scriptMs | 3.8 | 20.5 | ~5× |
| fixture `/form` | layoutMs | 3.0 | 13.2 | ~4.4× |
| | recalcStyleMs | 1.8 | 7.8 | ~4× |
| fixture loads | blockingMs | 0 | 0 | – |
| playground loads (e.g. `/users/:id`) | scriptMs | 4.8 | 21.9 | ~4.5× |
| | layoutMs | 2.7 | 11.4 | ~4× |
| | recalcStyleMs | 0.2 | 1.1 | ~5× |
| | blockingMs | 0 | 0 (one 70 ms long task in 1 of 3 `/api/users` loads) | – |
| scroll spans | durationMs | ~4 | ~8–9 | 2× |

- `scriptMs` scales 4.5–4.6× on the xhr-site keys and about 4.5–5.4× across all keys; `layoutMs` scales about 3.8–4.4× and `recalcStyleMs` about 4–5×.
- `blockingMs` does not scale; it jumps from 0. About 40 ms of work, under the 50 ms long-task threshold, becomes about 160–187 ms, so one new long task appears per heavy span. Pages with only a few ms of script get no long tasks at all.
- `durationMs` grows much less than 4× because most of a load span is fixed networkidle wait.
- At p=1 every span is tagged, so `degradation` has nothing to compare against and is absent, as documented.
- At p=0.5, the fault fired on 6 of 9 pages. Degradation reported `/items/:id :: load` Δ `durationMs` +210 to +216 and Δ `blockingMs` +167 to +170, which is consistent with the p=1 runs.
- The CPU throttle was the only fault that added main-thread work. The delay and 503 faults only added waiting.

### 7.4 Server-side faults (playground, traceparent join)

| key | server:latency faulted | clean | Δ |
|---|---|---|---|
| `/users/:id :: load` | 829.2 (829–830.4) n=3 | 531.6 (527.3–534.6) n=5 | **+298** (degradation +297.5, +298.4) |
| `/ :: load`, `/admin`, `/api/users`, `/users` loads | 828.6–875.4 (n=1 each) | 527–570 | ≈ +300 |
| `server:5xx`-tagged loads | 528–532 | – | ≈ 0 |

- The traceparent join attributed every latency event correctly. No span tagged `server:latency` was under 700 ms, and no load over 800 ms was left untagged.
- Server faults use their own unseeded RNG, so reps differ: 7, 5 and 4 fault events per run, and r2 visited 7 pages instead of 8.

### 7.5 Correctness checks (`check.mjs`, all 51 reports)

- Every network-fault tag was on a span in which a matching `/api/` request started.
- With the CPU fault at p=1, all 270 spans were tagged. At p=0.5 the tagged spans are consistently the slow ones.
- Every span in which a 290 ms+ `/api/` request *started* carried the delay tag. Untagged spans can still list 290 ms+ requests carried over from earlier spans (B2).

### 7.6 Caveats

- **The fault RNG is the crawler's seeded RNG.** Any probabilistic fault shifts the action sequence, so conditions run at the same seed are different crawls.
  - On the playground, the baseline clicks "User 4" while the delay and 503 runs click "User 8", and scroll offsets change.
  - On xhr-site, the baseline has 30 Reload and 21 Compute spans, the delay runs have 21 and 24, and the 503 runs add a scroll key.
  - This is documented in the README but not in the "Perf under chaos" section of `perf.md` (B12).
  - Comparisons here were made per key, and within a run where possible.
- **Load keys rarely get a degradation pair.** Each URL is visited once per crawl, so only a shared route pattern (`/items/:id`) produced pairs.
- **Networkidle hides XHR cost on clicks,** as documented.
- **Noise was low.** For client-side faults (crawler RNG), the same seed gives the same fault decisions in every rep; server-side faults in condition (e) do not (§7.4). Span medians varied by a few ms across reps. n is small: 3–30 spans per key, and 1–3 per server-fault key.
- `xhr-site` is a purpose-built synthetic app, not a tracked fixture.

---

## 8. E5: Leak trends and crawl-wide coverage

**Method.**
- A purpose-built site with these pages:
  - leaking pages: event listeners, DOM nodes, detached nodes plus heap;
  - non-leaking pages: `/control` (allocates and releases) and `/plateau` (a capped cache);
  - `/navleak` and `/spa`, each a leaking button next to links;
  - `/chain/<n>`, a chain of pages with no leak where each page is a new document;
  - coverage pages.
- Leak pages were crawled with `--max-pages 1 --max-actions 10 --perf [--perf-mem]`, seeds 1..5.
- Real crawls: v1, v2 and the fixture with `--max-pages 20 --max-actions 5`, seeds 1..5, with and without `--perf-mem`.
- Summaries were regenerated with the existing scripts into `E5-leaks-coverage/summaries/`.

**Leak detection (runs flagged)**

| page | `--perf --perf-mem` | `--perf` only |
|---|---|---|
| leak-listeners | 5/5 (listeners +139 to +180) | 5/5 |
| leak-dom | 5/5 (DOM nodes +1400 to +1800) | 5/5 |
| leak-detached | 5/5 (heap +7.2 to +9.2 MB) | 5/5 |
| control (no leak) | **0/5** | **5/5 false positives** (listeners +284 to +364) |
| plateau (no leak) | **0/5** | **5/5 false positives** |
| `/spa` (pushState) | 5/5, split across the `/spa/a` and `/spa/b` keys | – |
| `/navleak` | 0/5 (the leaking button ran twice per run, once per visit, too few samples for a trend) | – |
| `/chain/<n>` (no leak, 6 documents) | **5/5 false positives** (B1) | 0/5 |
| real crawls of v1, v2 and the fixture | 0/15 | 0/15 |

**Crawl duration (s, median [min–max], n=5)**

| target | `--perf` | `--perf-mem` | `--perf-cov` |
|---|---|---|---|
| v1 | 20.8 [20.5–21.1] | 23.7 [23.3–23.9] | 21.3 [21.2–21.4] |
| v2 | 22.6 [22.4–22.8] | 25.1 [24.9–25.4] | – |
| fixture | 34.5 [32.1–36.6] | 36.9 [34.3–38.7] | 36.0 [33.3–38.0] |

**Crawl-wide coverage**

| run | JS used / total | CSS used / total |
|---|---|---|
| `/app1` alone, no actions | 472/1864 (25.3%) | 14/66 (21.2%) |
| crawl, `--max-actions 0` | 940/1868 (50.3%) | 29/66 (43.9%) |
| crawl, `--max-actions 8`, seeds 1–5 | 1470/1934 (76.0%), identical in all 5; the unused function f4 is correctly counted as unused | 29/66 (43.9%); `.b3` is never counted (B7) |
| fixture crawl, seeds 1–5 | 556/714 (77.9%); `/api-consumer` at 65.4% because its `.catch` branch never ran | 0/0 |
| v1 crawl, 16 pages | 0/0 (`/dashboard`, the only page with JS, is never reached) | 0/0 |
| `/cov-inline` (two inline scripts) | **689/689 (100%)**, which is wrong (B4) | – |
| `/cov-ext` (the same code as external files) | 690/1362 (50.7%), correct | – |

**Interpretation**
- Leak trends are only accurate with `--perf-mem`. Without forced garbage collection, garbage that has not been collected yet counts as growth: on `/control`, listeners read 91 → 375 without GC and a flat 29 with it.
- **The `/chain` false positive:**
  - With `--perf-mem`, `documentsDelta` is 0 on every navigation, while perf-only runs marked 34–36 of 36 spans as document-creating.
  - As a result, the pages under the `/chain/:id` route are treated as one growing series, with listeners +160 to +180 and DOM nodes +800 to +900.
- Crawl-wide coverage adds real information as the crawl widens (25% → 76%).
- `--perf-mem` costs about 2.4–2.9 s per crawl of 57–95 spans (about 25–40 ms per span).

**Caveats**
- The test leaks are large and clear-cut. Leaks close to the detection thresholds were not tested.
- The real targets have almost no JS state. They show that there are no false positives, not that detection works.

---

## 9. E6: Browser cost under load (`scenarioLoad` + `perf`)

**Method.**
- Scenario on playground v1: list, then detail, then back.
- Settings: think time 100–300 ms, `duration: 25s`, `rampUp: 0ms`, `perf: { sampleWorkers: 1 }`.
- 1, 2, 4 and 8 workers with perf on, plus perf off at 4 and 8 workers.
- Three batches:
  - `v1`: plain pages;
  - `cpu`: adds a step with about 130 ms of fixed work;
  - `reg`: `PLAYGROUND_PERF_REGRESSION=1`.
- 5 repetitions: 70 timed runs, 0 failed iterations.
- **Load gate:** The gate waits until load1 is below 2, up to 150 s. It never timed out: 45 of 70 runs waited 0 s and the longest wait was 40 s. Median load1 before runs was still 1.26–1.96, because load1 lags the previous run.
- **Order:** Each rep ran w1-on, w2-on, w4-on, w8-on, w4-off, w8-off in that order. The off runs always followed w8-on, which explains their higher load1 (1.85 / 1.96 vs 1.39 / 1.26).

**Run level (v1, median [min–max], n=5)**

| config | throughput/s | sampled / unsampled worker iterations | /users p95 ms | list latency p50 / p95 | detail latency p50 / p95 | list span p50 |
|---|---|---|---|---|---|---|
| 1 worker, on | 1.20 [1.16–1.20] | – | 4.0 | 40 / 48 | 78 / 88 | 53 |
| 2 workers, on | 2.51 [2.51–2.59] | 0.85 | 5.0 | 42 / 56 | 75 / 103 | 54 |
| 4 workers, on | 4.94 [4.93–5.17] | 0.88 | 6.4 | 46 / 73 | 76 / 110 | 62 |
| 4 workers, off | 5.19 [5.18–5.27] | 0.98 | 6.8 | 46 / 74 | 72 / 104 | – |
| 8 workers, on | 8.90 [8.79–9.14] | 0.82 | 11 [10–15] | 72 / 134 | 120 / 184 | 92 [77–102] |
| 8 workers, off | 9.16 [8.99–9.41] | 0.98 | 13 [12–15] | 72 / 126 | 113 / 176 | – |

**Fixed work (`cpu`) and the busy loop (`reg`)**

| workers | cpu: compute latency p50 / p95 | cpu: blockingMs p50 / p95 | reg: list latency p50 / p95 | reg: list blockingMs p50 / p95 | reg: /users p95 |
|---|---|---|---|---|---|
| 1 | 131 / 147 | 128 / 144 | 193 / 204 | 150 / 150 | 4.0 |
| 2 | 132 / 147 | 129 / 142 | 195 / 212 | 150 / 150 | 4.9 |
| 4 | 135 / 153 | 132 / 148 | 208 / 245 | 150 / 150 | 9.7 |
| 8 | 151 / 191 | 141 [139–146] / 165 [157–190] | 252 / 332 | 150 / 153 | 26 [22–29] |

**Interpretation**
- **8 workers on 4 CPUs is likely CPU-bound.** This is inferred from 8 browser contexts sharing one Chromium on 4 cores; CPU utilisation was not measured (only `os.loadavg()` before and after each run). The server adds only a few milliseconds. The latency growth is therefore not attributed to either the tool or the app.
- **Blocking time:**
  - On plain pages, `blockingMs` stays at 0.
  - For fixed work, it grows about 10% at p50 and about 15% at p95, mostly between 4 and 8 workers.
  - The busy loop runs for a fixed 150 ms of wall time, so it reads 150 at any load. That confirms the measurement is correct, but it cannot show contention.
- **Cost of sampling:**
  - Total throughput is 4.8% lower at 4 workers and 2.8% lower at 8.
  - The sampled worker completes 0.82–0.92× the iterations of the unsampled workers across all perf-on configs, against 0.98 with perf off.
  - A span lasts about 13 ms longer than its step at 1 worker, and 20–40 ms longer at 8 workers.
- In `reg`, the back step reads 150 ms of blocking because the page is reloaded rather than restored from the back-forward cache.

**Caveats**
- The on/off comparison exists only for v1 at 4 and 8 workers. `cpu` and `reg` have no off runs, and 1 worker with perf off was not run.
- Only one worker was sampled, giving 16–30 spans per step. The per-second timeline is too sparse at `sampleWorkers: 1`.
- INP could not be measured: only 1–2 samples per run, and only in reg `detail` at 4 and 8 workers. The likely reason is that the click is a link navigation (B16), but this was not verified.

---

## 10. E7: `perfSeekingDriver`

**Method.**
- A 10-button page: Heavy (200 ms), Medium (80 ms) and 8 cheap buttons. 30 steps per crawl, seeds 1..10.
- Four modes:
  - `default`: the built-in random loop;
  - `wr`: `weightedRandomDriver`;
  - `ps`: `perfSeekingDriver`;
  - `ps-prior`: `perfSeekingDriver` given the previous seed's report.
- The same runs on playground v1 with the regression (1 rep). Plain v1 used only seeds 1..5 and only the `wr` and `ps` modes.

**Button page (median [min–max], 10 seeds)**

| mode | first step on Heavy | Heavy never clicked | share of expensive steps (≥50 ms) | Heavy share | wall s |
|---|---|---|---|---|---|
| default | 5 [1–12] | 1/10 | 23% [17–37] | 10% [0–23] | 6.5 |
| wr | 5 [1–12] | 1/10 | 23% [17–37] | 10% [0–23] | 6.8 |
| ps | 3 [2–10] | 0/10 | 67% [60–70] | 50% [37–60] | 9.3 |
| ps-prior | 2.5 [1–6] | 0/10 | 78% [67–87] | 52% [43–70] | 9.6 |

**Repeatability**
- In a second rep, `wr` sequences were identical on 10 of 10 seeds and `ps` on only 7 of 10. The three that diverged were s1 at step 27, s7 at step 11 and s10 at step 26.
- Each divergence swaps between Heavy and Medium after timings that differ by about 1 ms. That points to timing-dependent scoring; this is inferred, not traced in code.
- The first-hit step reproduced for all 10 seeds, and the Heavy share moved by at most 4 points.

**Playground**
- **v1 with the regression:** The only expensive action is clicking "Users" on `/` (150 ms), and it can only be chosen on step 1. Hit rates were default 2/10, wr 2/10, ps 4/10 and ps-prior 3/10. With one chance per crawl and one rep, this is too few to rank the strategies.
- **Plain v1:** No action has any blocking time, so `ps` and `wr` behave the same.

**Interpretation**
- The driver weights each action by `blockingMs + interaction.maxDurationMs + 1`, so Heavy's time is counted twice (a weight of about 401). This does not change the ranking.
- Most of the benefit comes after the first hit, because the first steps are uniform.
- A prior helps less when most candidates on a page have not been measured yet, because each unmeasured candidate is given the average cost.
- `ps` costs about 40% more wall time than `wr`.

**Caveats:** The test page is synthetic and very clean, and the driver does not weigh the cost of page loads.

---

## 11. Timing hygiene

| experiment | reps | load gate | order |
|---|---|---|---|
| E1 | 5 | once per rep, before `off` | fixed (confounded) |
| E2 | 5 + seeds | per run | per mode, in turn |
| E2b | 5 | per run, never waited | interleaved |
| E3 | 5 | per batch | per target |
| E4 | 3 | per rep, never waited (51/51) | sequential per condition |
| E5 | 5 seeds | load recorded | sequential |
| E6 | 5 | per run, never hit the cap (max 40 s) | fixed; off runs after w8-on |
| E7 | 10 seeds + 1 rep | per run | interleaved per seed |

---

## 12. Bugs and limitations found

Type: **code** is a defect in chaosbringer or lightbringer code; **doc** is behaviour that is correct or unavoidable but undocumented or documented wrongly; **design** is a limitation of the current model. Repro paths are relative to the evaluation scratch directory.

| # | severity | type | finding | repro | experiment |
|---|---|---|---|---|---|
| B1 | **High** | code | Under `--perf-mem`, `documentsDelta` reads 0 on navigations where it should read 1, because the forced GC removes the old document before the reading is taken. `buildPerfTrends` (`perf-summary.ts` near line 160) needs `documentsDelta > 0` to leave out navigation spans and to start a new series after a navigation, so both are off. The result is false leaks across documents. | `/chain/1`, `--max-pages 6 --max-actions 5 --perf --perf-mem`, seeds 1..5: flagged 5/5, 0/5 without `--perf-mem` (`E5-leaks-coverage/leak/chain/`, `E5-leaks-coverage/summaries/chain.txt`). Per-page `documentsDelta` is all 0 with mem and all 1 without it in `E1-overhead/fixture/{mem,light}/r1/report.json`. | E1, E5 |
| B2 | **Medium** | code | Under networkidle, an in-flight request is counted in several spans. A delayed XHR fired by a click is listed on that click span (with `durationMs: 0` when still in flight at span close, e.g. `actions[3]` and `[11]`; with its full ~305 ms in `actions[13]`), then again with a negative `startOffsetMs` in the next 1–2 spans, where it counts in `requestCount`. One of those later spans is an untagged click that made no request. As a result, `requestCount` inflates on spans that fired nothing (breaking the `emit-budgets` "no request stays no request" rule), the fault's cost lands on clean spans, and `degradation` reports **−24 to −30 ms** for the delay fault in 3/3 reps. It does not happen under adaptive, where the same fault reads +281 ms. Cause: `buildSpanNetwork` (`lightbringer/src/analyze/network.ts:377-389`) keeps any request whose interval overlaps the span, not only those that started in it, and uses `end = r.endEpochMs ?? r.startEpochMs` for in-flight requests. | `E4-chaos/runs/xhr-delay-r1.json`, `report.actions[13..15].perf.network` (carry-over: the request is listed with 305.6 ms on the originating Reload span `[13]`, then at −115.7 in `[14]` and −266.8 in the untagged Compute span `[15]`); `actions[3]`, `[11]` for `durationMs: 0`; rerun with `E4-chaos/xhr-site.mjs` + `E4-chaos/run.mjs xhr delay 1` | E4 |
| B3 | Medium | code | The crawl-wide vitals summary (`perf-summary.ts:73-74`) takes the final document's vitals and labels them with the visited page's URL. When an action navigates away, the visited page's own vitals are dropped and the next page's are credited to it. The per-page sidecar files have the same mismatch. | `E3-hotspots/v1/r1.json`: page `/` has LCP 60 on `/` and 44 on `/api/users`, but the summary's worst LCP is `{44, url: "/"}` | E3 |
| B4 | Medium | code | Several inline scripts on one page are merged into one coverage entry (`groupRangesByUrl`), which overstates usage. This also affects `lightbringer run`. | `E5-leaks-coverage/cov/inline-single*` reports 100%; `ext-single*` (same code as external files) reports 50.7% | E5 |
| B5 | Medium | code | `perf regress` does not check the settle mode. Under networkidle an action span excludes the fixed 100 ms pause (`crawler.ts:2096`); under adaptive the settle is inside the span. Comparing runs across modes gives false regressions and exit 1. | `perf regress E2-settle/runs/perf/v1-networkidle-s42.json --current E2-settle/runs/perf/v1-adaptive-s42.json` reports `/admin :: scroll` 4.3 → 25.3 ms (+488%) | E2 |
| B6 | Medium | doc | `--settle adaptive` and short fixed settles leave a page before errors thrown 150–2000 ms after load. Adaptive and 50 ms caught 0/5, networkidle 3/5 and 250 ms 1/5, in every rep. `perf.md` presents adaptive as keeping findings, without this caveat. | `E2b-late-errors/runs/{adaptive,networkidle}-r1.json`, `E2b-late-errors/analysis.txt` | E2b |
| B7 | Low–Medium | doc/design (Chromium?) | CSS coverage keeps only the last document of each page visit, while JS keeps them all. This is probably a Chromium limitation, and it contradicts the docs. | `E5-leaks-coverage/cov/lib-crawl-act-s1-perf/` | E5 |
| B8 | Medium | doc | Under networkidle, the page's own XHRs are aborted when the crawler navigates away, and they show up as an app error cluster (`ERR_ABORTED`). | `E2-settle/xhr/C-links-driver-s2-networkidle.json` | E2 |
| B9 | Low | doc | `perf.md` says adaptive lets the next step see what an XHR rendered. That is true only with a driver or trace replay. | `E2-settle/xhr/`, probe B vs probe C | E2 |
| B10 | Low | doc | Without `--perf-mem`, trends flagged 10 of 10 non-leaking single-document runs (`/control`, `/plateau`; 10 of 30 across all non-leaking E5 runs). The docs call `--perf-mem` "more trustworthy"; in practice it is required. | `E5-leaks-coverage/summaries/leaks-nomem.txt` | E5 |
| B11 | Low | design (output wording) | The degradation "clean" side mixes in spans with other faults, which produces implausible deltas: `/users/:id :: load [server:5xx]` Δ −297.5 / −298.4 ms, because the "clean" spans were latency-faulted. This behaviour is documented, but the entry reads as "503 makes loads 300 ms faster". | `E4-chaos/runs/playground-server-r{1,2}.json`, `perf.degradation` | E4 |
| B12 | Low | doc | Probabilistic faults draw from the crawler's seeded RNG, so conditions run at the same seed are different crawls. This is in the README but not in `perf.md` "Perf under chaos". | `E4-chaos/runs/playground-base-r1.json` vs `playground-delay-r1.json` ("User 4" vs "User 8") | E4 |
| B13 | Low | code | The drilldown labels chaosbringer's injected collector code as `[native]` (`drilldown.ts:227`), and its `PERF_CSS=1` hint has no chaosbringer CLI flag. | `E3-hotspots/drilldown/` | E3 |
| B14 | Low (unconfirmed) | suspected | Long tasks during a click that navigates may be missed: `blockingMs` read 0 while the trace showed 115 ms of long tasks. | `perf drilldown E3-hotspots/fixture/r4.json '/spa/items/:id :: click a:has-text("back")'` | E3 |
| B15 | Low | doc (Chromium) | Long tasks started directly by `page.evaluate` do not show in `blockingMs`. The same work scheduled through `setTimeout` reads about 130 ms. | `E6-load/longtask-probe.mjs` | E6 |
| B16 | Low | doc | Clicks that navigate almost never get `interactionMs`, so an `interactionMsP95` SLO on such a step fails with `actual: null`. | `E6-load/runs/inp-probe.json` | E6 |
| B17 | Low | design | After a click that navigates, the rest of the visit is still keyed under the old page's URL, so those measurements can never be matched to a candidate. The default and driver loops also count steps differently on navigation (42–43 vs 50). | `E7-perf-seeking/pg-v1-regr/default-s1.json` vs `wr-s1.json` | E7 |
| B18 | Low | design (inferred) | `perfSeekingDriver` sequences are not reproducible per seed: 7/10 identical across reps, with swaps between near-tied candidates after timings about 1 ms apart. | `E7-perf-seeking/repeatability.txt`, `buttons/` vs `buttons-rep2/` | E7 |
| B19 | Low | code | Three small output problems: a crawl with no JS reports `usedPct: 0` instead of leaving it out; `lowUsage` lists files at 100% usage; and the last, unfinished iteration of a load run is not measured. | `E5-leaks-coverage/cov/`; `E6-load/runs/calib2-30M.json` | E5, E6 |

---

## 13. Recommendations

1. **Fix B1 before recommending `--perf-mem` for trends.**
   - Detect navigations with a signal that GC cannot cancel, such as the main-frame navigation count or `Documents` read before the forced collection.
   - At minimum, never include load spans in trends.
   - Until the fix lands, document that trends need `--perf-mem` (B10) and have this limitation.
2. **Fix B2 so that a span counts only requests that started inside its window,** or split out a separate "carried-over" list. Until then, `degradation.requestCount` and click-span budgets under networkidle cannot be trusted when XHR faults are active.
3. **Keep `--settle adaptive` opt-in, as decided in §10 of the design, and recommend it by purpose:**
   - **Recommend adaptive** for perf and `perf regress` crawls, where `durationMs` then reflects app work and `durationMs` signals are about 4× stronger (+23% → +94%; +30% → +120%). Also recommend it for driver crawls, where it finds XHR-rendered content and avoids the B8 cluster. It is 2.9–3.5× faster, with identical results on the default-loop E2 crawls (seed 42 on 3 targets, 15/15 seed pairs).
   - **Do not use adaptive, or a 50 ms settle, when hunting late async errors (E2b).** Use networkidle, or a fixed settle long enough to cover the expected delay; even networkidle missed errors at 800 and 2000 ms.
   - Document the E2b limitation (B6) and fix the wording behind B9.
   - Add a settle-mode check to `perf regress` (B5). Switching modes invalidates existing baselines.
4. **Perf under chaos (E4):**
   - Measure XHR faults on action spans with `settle: "adaptive"`. Under networkidle, click spans close before the response arrives, which hides the cost and triggers B2.
   - Use `schedule` for comparisons across conditions, or compare within a run through `degradation`. With probabilistic faults at the same seed, conditions are different crawls (B12).
   - Use a partial probability, such as p=0.5, for lifecycle faults such as `faults.cpu`, so that `degradation` has clean spans to compare against.
   - Make the degradation clean side exclude spans that carry other faults, or flag entries whose clean side carries them (B11).
   - Gate CPU regressions on `scriptMs` rather than `blockingMs`. `blockingMs` jumps from 0 once work crosses the 50 ms threshold instead of scaling.
5. **Budget headroom on shared runners:**
   - Observed noise: wall time varied 2–7% at load below 2, and span medians varied about ±3%, with single outliers up to +35%.
   - For `blockingMs`, `scriptMs` and `busyMs` budgets, allow +20–25% or +20 ms, whichever is larger. `busyMs` and `blockingMs` were stable to about 1 ms on the seeded keys, but `scriptMs` varied by up to 3.5 ms on a null split (9.6 → 6.1) and `blockingMs` has occasional 50–70 ms outliers (E4 baseline 0–58; one 70 ms long task on the playground).
   - Under networkidle, gate on `durationMs` only for large changes.
   - Under load with more workers than cores, allow +15% on blocking p95 and 2–3× on latency p95.
   - Always gate on the median of 3–5 or more runs.
6. **Features, in order of value:**
   1. `--perf` + `perf regress` on `blockingMs`, `scriptMs` and `busyMs`;
   2. `--settle adaptive`, for perf crawls and driver crawls;
   3. perf under chaos with adaptive settle, after B2 is fixed;
   4. `--perf-cov`, after B4 is fixed;
   5. `perfSeekingDriver`, for single-page apps whose cost is in click handlers;
   6. `--perf-trace`, only when you need a drilldown;
   7. `--perf-mem`, only for leak hunts, after B1 is fixed.
7. **Fix B3 and B4:**
   - build the vitals summary from each document, with that document's own URL;
   - give each inline script its own coverage entry.
8. **Add to the docs:**
   - under networkidle, `durationMs` is mostly settle time;
   - adaptive misses late async errors (B6);
   - the fault RNG is shared with the crawler (B12);
   - `page.evaluate` long tasks are not seen (B15);
   - navigating clicks have no INP (B16);
   - the timeline is too sparse at `sampleWorkers: 1`.
9. **Follow-ups:**
   - rerun E1 with a rotated config order;
   - measure E2b-style late errors on crawls that perform actions;
   - rerun the E7 playground comparison with more seeds and reps.

---

## Appendix: commands

Run the commands from the repo root, the worktree at `19af79a`. `<eval>/` stands for the evaluation scratch directory (not committed).

```sh
# servers
(cd packages/chaosbringer && PORT=4101 npx tsx fixtures/site/server.ts)
(cd playground && VARIANT=v1 PORT=5101 npx tsx server.ts)
(cd playground && VARIANT=v2 PORT=5102 npx tsx server.ts)
(cd playground && VARIANT=v1 PORT=5104 PLAYGROUND_PERF_REGRESSION=1 npx tsx server.ts)
# E1
node packages/chaosbringer/dist/cli.js --url http://127.0.0.1:4101 --seed 42 --max-pages 10 --max-actions 3 $FLAGS --output D/report.json --compact
<eval>/E1-overhead/run.sh fixture 5 ; node <eval>/E1-overhead/analyze.mjs fixture
# E2
node packages/chaosbringer/dist/cli.js --url $URL --seed $S --max-pages 10 --settle {networkidle|adaptive|50|250} --output x.json --quiet
node packages/chaosbringer/dist/cli.js perf regress <eval>/E2-settle/runs/perf/v1-networkidle-s42.json --current <eval>/E2-settle/runs/perf/v1-adaptive-s42.json
# E2b
PORT=5720 node <eval>/E2b-late-errors/server.mjs
node packages/chaosbringer/dist/cli.js --url http://127.0.0.1:5720/ --seed 1 --max-pages 6 --max-actions 0 --settle {networkidle|adaptive|50|250} --output <eval>/E2b-late-errors/runs/<mode>-r<n>.json --quiet
# E3
node packages/chaosbringer/dist/cli.js --url $URL --seed 42 --perf --perf-trace --perf-out L/perf-r$i --output L/r$i.json --compact --max-pages 8 --max-actions 2 --ignore-preset analytics [--settle adaptive]
node packages/chaosbringer/dist/cli.js perf drilldown <eval>/E3-hotspots/fixture/r4.json '/spa/items/:id :: click a:has-text("back")'
# E4
PORT=4601 node <eval>/E4-chaos/xhr-site.mjs
(cd packages/chaosbringer && node <eval>/E4-chaos/run.mjs {xhr|fixture|playground} {base|delay|s503|cpu4|cpu4p|server|adbase|addelay|ad503} <rep> http://127.0.0.1:<port>)
<eval>/E4-chaos/all.sh ; node <eval>/E4-chaos/analyze.mjs ; node <eval>/E4-chaos/check.mjs
# E5
node packages/chaosbringer/dist/cli.js --url http://127.0.0.1:5055/<page> --max-pages 1 --max-actions 10 --seed {1..5} --perf [--perf-mem] --output ... --compact
node packages/chaosbringer/dist/cli.js --url http://127.0.0.1:5055/chain/1 --max-pages 6 --max-actions 5 --perf --perf-mem --seed 1 --output mem-s1.json
# E6
node <eval>/E6-load/run-one.mjs http://127.0.0.1:5101 <workers> <on|off> 25 runs/v1-w4-on-r1.json
<eval>/E6-load/batch.sh v1 http://127.0.0.1:5101 5 1:on 2:on 4:on 8:on 4:off 8:off ; node <eval>/E6-load/analyze.mjs v1
# E7
PORT=5710 node <eval>/E7-perf-seeking/server.mjs
node <eval>/E7-perf-seeking/run.mjs {default|wr|ps|ps-prior} <seed> <out> http://127.0.0.1:5710 1 30 [prior.json]
```
