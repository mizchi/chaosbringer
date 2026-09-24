# lightbringer — a reading guide

This is the narrative companion to the [README](../README.md). The README is the
reference (every flag, every type); this page is for a human sitting down for the
first time: **how to measure, and how to read what comes back.**

If you remember one thing: every number is broken down into
**network / CPU / render / memory / interaction / frames**, all on one shared
clock, so the only way to move a number is to change the implementation — not to
change how the test waits.

---

## 1. Measure

There are three entry points. They all produce the same report and obey the same
`PERF_*` flags — pick the one that fits how much you want to touch your tests.
(Prefer to learn by running? The [sample project](../examples/sample-project/) is a
self-contained app wired up all three ways.)

### A. Fixture with explicit spans (recommended)

You name the regions you care about. Put the `waitFor`/`expect` **inside** the
action so the span covers "until the operation is actually done".

```ts
import { test, expect } from "lightbringer";

test("home", async ({ page, perf }) => {
  await perf.measure("initial-load", async () => {
    await page.goto("https://example.com");
    await expect(page.getByRole("heading")).toBeVisible();
  });

  await perf.measure("open-search", async () => {
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
```

```sh
pnpm exec playwright test
```

### B. Auto-span (one-line import swap)

To put numbers on a spec you already have, swap the import. Every `page.goto` and
every Locator action (`getByRole(...).click()`, `locator(...).fill()`, …) becomes
its own span automatically — no other edits.

```diff
- import { test, expect } from "@playwright/test";
+ import { test, expect } from "lightbringer/auto";
```

Trade-off: an auto-span covers **one action's own cost** (the action plus a short
settle), not "until your next assertion". When you need the wider window, use path A.

### C. CLI (no install, no spec)

Describe the scenario as JSON and run it with `npx` — nothing to add to your repo:

```json
{
  "url": "https://example.com",
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    { "name": "initial-load", "goto": "/", "waitFor": "h1" },
    { "name": "open-search", "click": "button[aria-label=Search]", "waitFor": "[role=dialog]" }
  ]
}
```

```sh
npx lightbringer run scenario.json
npx lightbringer run e2e/existing.spec.ts --config playwright.config.ts   # or reuse a real spec + config
```

---

## 2. Read the output

A summary is printed for every test (and the full report is written to
`perf-results/<title>.run<idx>.json`). Here is a **real** report — a two-step
scenario (load a heavy page, then scroll) measured on a laptop:

```
[perf] load and scroll
  vitals  LCP=924 (good)  INP=n/a  CLS=0 (good)  TTFB=261.9 (good)
    lcp ttfb=261.9 / load-delay=0 / load=0 / render-delay=662.1ms
    render-blocking: 7 css, 14 js  [//fonts.googleapis.com/css2?family=Roboto…, /cssbin/www-main…]
  initial-load                3877.4ms
      net   busy=1122.2ms  136reqs  5waves  3738.5KB
      3p    101reqs  125.4KB  busy=510.8ms  [gstatic.com 77.5KB, google.com 28.6KB, googleapis.com 17.8KB]
      ↳ from (anonymous)  k=…kevlar_base…:26096 (88)  /:21 (10)  k=…kevlar_base…:3632 (7)
      cpu   block=271ms  longtasks=1  maxTask=271ms  loaf=2/230.7ms
      frames 109fps  15 dropped  longest=274.9ms
      render style=62/14ms  layout=25/13.5ms  nodes=7045  script=387ms
      mem   heap=40MB (+39.4MB)  arraybufs=87  listeners=1191 (+1191)  docs=+5  domNodes=7053  (pre-GC; set PERF_MEM=1 for retained-only deltas)
  scroll                      2023.8ms
      net   busy=0ms  0reqs  0waves  0KB
      cpu   block=0ms  longtasks=0  maxTask=0ms  loaf=0/0ms
      render style=0/0ms  layout=0/0ms  nodes=0  script=3.1ms
      mem   heap=46.3MB (+6.4MB)  arraybufs=87  listeners=1191 (+0)  docs=+0  domNodes=7053  (pre-GC; …)
  css   17 sheets / 21349 rules / 24978 selectors  ×  2025 DOM nodes  (large selector×DOM product — PERF_CSS=1 …)
  total network 136 reqs / 3738.5KB
    third-party 101 reqs / 125.4KB (3% of bytes) across 6 domains
  ! software GL (SwiftShader): GPU / render numbers are NOT real hardware. Use PERF_GPU=1.
```

In a real terminal this is **colour-coded by importance** (stripped here because
the page is plain text): metric labels are dimmed so the values stand out, web-vital
ratings are green / yellow / red, notable costs (a slow step, jank, over-fetch, a
`capped` span) are yellow, and genuine problems (a broken budget, a likely leak, an
invalid run) are red. Routine zero-cost lines are dimmed — present for completeness,
not for your attention. Colour follows `NO_COLOR` / `PERF_COLOR=0|1` and turns off
automatically when the output isn't a terminal (CI logs, `> file`).

### Line by line

**Page-global header** (measured once for the whole page):

| Line | What it tells you |
| --- | --- |
| `vitals LCP/INP/CLS/TTFB` | The Core Web Vitals with their good/needs-improvement/poor rating. `INP=n/a` just means no interaction happened. |
| `lcp ttfb / load-delay / load / render-delay` | **Where the LCP time went.** Here LCP=924ms is almost all `render-delay` (662ms) — the largest element was painted late, not slow to download. That points at render-blocking work, not the network. |
| `render-blocking: N css, M js` | Resources in `<head>` that hold up first paint (stylesheets + non-async/defer classic scripts). The list names the worst offenders. |

**Per-span block** (one per `perf.measure` / auto-span). The first line is
`name  durationMs` (plus `(capped)` if it hit the settle timeout):

| Line | What it tells you |
| --- | --- |
| `net busy=… reqs waves KB` | Time the network was actually busy inside the span, request count, number of dependency **waves** (a deep waterfall = many waves), and bytes. If you see `(net-saturated: busyMs ≈ window)` the page never stopped loading (polling/ads) — `busyMs` is then a wait window, not a discrete cost. |
| `3p …` | Third-party slice of that network (bytes / requests / busy time / top domains). Appears only when there are third-party requests. |
| `↳ from …` | **Which code issued the requests** (initiator script + frame, with counts). The network equivalent of "who's responsible". Shown for deep/heavy waterfalls. |
| `cpu block=… longtasks maxTask loaf` | Main-thread blocking time, count and size of long tasks, and LoAF (long-animation-frame) blocking. This is "how long the main thread was stuck". |
| `inp type=…ms (input / proc / present)` | Worst interaction in the span, split into input delay / processing / presentation. Shown only when an interaction occurred (see §3). |
| `frames Nfps dropped longest` | Frame cadence. Only printed when there's an actual hitch (dropped frames or a frame gap > 33ms); smooth spans stay quiet. |
| `render style=c/ms layout=c/ms nodes script=ms` | Style-recalc (count/time), layout (count/time), DOM node count, and **`script`** — the single most trustworthy number here (CDP `ScriptDuration`, ±1ms). With `PERF_TRACE=1`/`PERF_GPU=1` you also get `paint=` and `gpu=`. |
| `mem heap=…(Δ) arraybufs listeners(Δ) docs(Δ) domNodes` | Memory gauges and their change across the span. `arraybufs` is a **count**, not bytes. The `(pre-GC)` note means deltas still include uncollected garbage; add `PERF_MEM=1` for retained-only numbers. |

**Page-global footer:**

| Line | What it tells you |
| --- | --- |
| `css … sheets / rules / selectors × … DOM nodes` | CSS×DOM capacity — the structural ceiling on style-recalc cost. A large `selectors × domNodes` product earns a warning; `PERF_CSS=1` then shows *which* selectors are expensive. |
| `total network …` / `third-party …` | Scenario-wide totals, and the third-party share of bytes across how many domains. |
| `! …` lines | Warnings that make results suspect: software GL (`SwiftShader` → GPU/paint numbers are fake, use `PERF_GPU=1`), page errors during the run, the in-page collector never running, or a budget violation. **Read these first.** |

> In this sample the takeaway is immediate: the page is *render*-bound, not
> network-bound (LCP render-delay dominates, `script=387ms` and `block=271ms` in
> one long task), it ships a heavy DOM (7045 nodes) and a big stylesheet
> (24978 selectors), and the GPU numbers are not real because it ran on
> SwiftShader.

---

## 3. Patterns worth recognizing

**Interaction latency (INP) — where the jank is.** From a keystroke benchmark:

```
  type                         898.7ms
      cpu   block=391ms  longtasks=6  maxTask=69ms  loaf=5/19.2ms
      inp   keydown=72ms  (input 0.4 / proc 0.5 / present 71.1)  17 interactions
```

The 72ms is almost entirely `present` (71.1) — the handler is cheap, the *repaint*
after it is what's slow. Input-delay-dominated would point at a busy main thread
instead; processing-dominated would point at the handler itself.

**Memory leak trend** — a single span's `Δheap` is too noisy to call a leak. Repeat
the same step with `perf.measureRepeat(name, action, { times })` (use `PERF_MEM=1`)
and lightbringer looks for *distributed monotonic growth* across the repeats:

```
  memory trends (across repeated steps):
    alloc x6  jsHeapUsedMB 12→21.2→30.4→39.6→48.8→58MB  +46MB (+9.2/step)  ⚠ likely leak
    alloc x6  jsEventListeners 192→212→232→252→272→292  +100 (+20/step)  ⚠ likely leak
    alloc x6  domNodes 55→75→95→115→135→155  +100 (+20/step)  ⚠ likely leak
    alloc x6  arrayBuffers 30→60→90→120→150→180  +150 (+30/step)  ⚠ likely leak
```

Clean linear climbs on heap **and** listeners **and** nodes is an unambiguous
leak. The count-based series (listeners / nodes / arraybufs) are the most reliable
signal — heap alone bounces with GC.

**A clean span**, for contrast — quiet is good:

```
  scroll                      2023.8ms
      net   busy=0ms  0reqs  0waves  0KB
      cpu   block=0ms  longtasks=0  maxTask=0ms  loaf=0/0ms
      render style=0/0ms  layout=0/0ms  nodes=0  script=3.1ms
```

No network, no blocking, no layout — the work this step claimed to do cost almost
nothing. (`frames` and `inp` lines are simply absent when there's nothing to report.)

---

## 4. Make it trustworthy

A laptop on localhost hides real-world cost; a single run is noisy. Three levers
(full details in the README):

- **Throttle** — `PERF_CPU=4` (mid-tier device), `PERF_NET=fast-3g`, `PERF_GPU=1`
  (real GPU numbers instead of SwiftShader).
- **Median out the noise** — `pnpm exec playwright test --repeat-each=5` then
  `node node_modules/lightbringer/scripts/median.mjs`. Gate CI on the **median**,
  and prefer the stable metrics (`script`/`scriptMs`, request count, node count)
  over the jittery ones (`duration`, `blocking`).
- **Budgets & regression gate** — declare per-span upper bounds (`perf.measure(…,
  { budget })`) for an absolute gate, or `scripts/regress.mjs <baseline> <current>`
  for a baseline-relative one (fail when something gets >N% worse).

---

## Gotcha: the fixture dev-server port

The bundled bench fixtures (and the CLI's JSON scenarios with relative URLs) serve
on port **5173** by default. If another Vite project is already on 5173, Playwright
will *reuse* it and silently measure the wrong app (you'll see locator-not-found
failures). Set `PERF_PORT=<free port>` to avoid the collision.
