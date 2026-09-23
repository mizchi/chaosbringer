# Sample project

A tiny, self-contained app you can measure end to end — the fastest way to *feel*
what lightbringer reports before pointing it at your own code. It deliberately
contains a few things worth finding:

- a real **network** load (data fetched over HTTP, in two waves),
- a **filter** input whose cost is pure script/render,
- a **"Watch all"** button that **leaks** memory on every click.

```
examples/sample-project/
├── app/index.html      # the demo app (self-contained: inline JS + CSS)
├── serve.mjs           # zero-dependency static server + a fake /api with latency
├── scenario.json       # CLI scenario (the no-install path)
├── measure.spec.ts     # fixture spec with explicit perf.measure spans
└── playwright.config.ts# self-contained config (starts serve.mjs for you)
```

> Inside this repo `measure.spec.ts` imports lightbringer by relative path. In a
> real project it's `import { test, expect } from "lightbringer"`.

---

## Run it — two ways

### A. Fixture spec (one command)

The config starts the server for you, so from the repo root:

```sh
pnpm exec playwright test --config examples/sample-project/playwright.config.ts

# retained-only memory deltas (makes the leak trend exact):
PERF_MEM=1 pnpm exec playwright test --config examples/sample-project/playwright.config.ts
```

### B. CLI scenario (no spec, no install)

Start the server, then run the JSON scenario:

```sh
node examples/sample-project/serve.mjs &                       # http://localhost:4321
npx lightbringer run examples/sample-project/scenario.json     # or: node dist/cli.js run …
```

Both produce the same kind of report. The fixture path additionally repeats the
leaky step (`measureRepeat`) to surface a memory trend.

---

## What you'll see

A real run of the fixture spec (`PERF_MEM=1`, abridged):

```
[perf] sample store
  vitals  LCP=12 (good)  INP=24 (good)  CLS=0 (good)  TTFB=1.4 (good)
  initial-load                 217.8ms
      net   busy=123.8ms  2reqs  2waves  20.2KB
      ↳ from fetchPage  /:69 (1)  (other) (1)
      render style=2/0.9ms  layout=2/4.2ms  nodes=1553  script=1.2ms
      mem   heap=1.6MB (+1.1MB)  listeners=29 (+29)  domNodes=1550
  load-more                    255.9ms
      net   busy=121.4ms  1reqs  1waves  15.6KB
      inp   pointerdown=24ms  (input 0.1 / proc 0.2 / present 23.7)  3 interactions
      render style=4/0.8ms  layout=2/2.8ms  nodes=3001  script=1.4ms
  filter                        32.7ms
      net   busy=0ms  0reqs  0waves  0KB
      render style=6/0.3ms  layout=3/0.4ms  nodes=386  script=0.6ms
  watch#0 … watch#3            (the leaky step, repeated 4×)
      mem   heap=6.4MB → 11.1 → 15.7 → 20.4MB   listeners +600/step   domNodes +1200/step
  memory trends (across repeated steps):
    watch x4  jsHeapUsedMB 6.4→11.1→15.7→20.4MB  +14MB (+4.7/step)  ⚠ likely leak
    watch x4  jsEventListeners 628→1228→1828→2428  +1800 (+600/step)  ⚠ likely leak
    watch x4  domNodes 1637→2837→4037→5237  +3600 (+1200/step)  ⚠ likely leak
  total network 3 reqs / 35.8KB
```

How to read it (full walkthrough: [`../../docs/guide.md`](../../docs/guide.md)):

- **`initial-load`** is **network-bound** — `busy=123.8ms` across `2waves` while
  `script` is ~1ms. The `↳ from fetchPage /:69` line names the code that issued
  the requests.
- **`load-more`** adds **one more wave** and doubles the DOM (`nodes` 1553 → 3001).
  Its `inp` is `present`-dominated: the click handler is cheap, the re-render isn't.
- **`filter`** does **no network** — its whole cost is script/render. This is the
  knob you'd optimize if filtering felt sluggish.
- **`watch`** is the planted leak: heap, listeners, and DOM nodes all climb
  linearly across the four repeats, so the trend section flags **⚠ likely leak**
  on all three. (One span's delta alone is too noisy to call — the *trend* is the
  signal.)

---

## Try changing things

- Delete the `watchers.push(...)` retention in `app/index.html` → the trend stops
  flagging a leak.
- Add `PERF_CPU=4` (throttle CPU) or `PERF_NET=fast-3g` → watch `load-more` and
  `filter` get more expensive, the way they would on a real device.
- Add a `budget` to a `perf.measure` call in `measure.spec.ts` (e.g.
  `{ requestCount: 1 }` on `load-more`) → see a `! budget:` violation line.
