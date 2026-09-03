# chaosbringer

Playwright-based chaos testing for web apps. Crawls the pages you point it at, performs weighted random actions, injects network faults, evaluates invariants, and reports what broke — with a seed you can replay.

## Where chaosbringer fits in the chaos layering

`chaosbringer` only injects faults that a **browser-driven** test can reach. Server-internal failure modes need a sibling library. Use this table to pick the layer before reaching for a fault provider:

| Layer | Library | What it touches | When to use |
|---|---|---|---|
| **Application state** | (your test setup; see [`#60`](https://github.com/mizchi/chaosbringer/issues/60) for a built-in hook) | Backend rows, storage state, fixtures | "Crawler needs N todos to navigate" |
| **Network** | `chaosbringer` `faults.*` | HTTP between browser and server (Playwright `route()`) | "What does the UI do when `/api/x` is 500 / slow / aborted" |
| **Page lifecycle / runtime** | `chaosbringer` `lifecycleFaults` / `runtimeFaults` | Browser DOM, storage wipe, CPU throttle, `fetch` / clock monkey-patches | "Does the SPA recover when localStorage gets wiped mid-action" |
| **Server-side** | [`@mizchi/server-faults`](https://github.com/mizchi/chaosbringer/tree/main/packages/server-faults) | Inside the server process, before the handler runs | "Do the server's own OTel traces / metrics show the fault, and does the handler degrade gracefully" |
| **Cloudflare bindings** | (proposed [`#61`](https://github.com/mizchi/chaosbringer/issues/61) `@mizchi/cf-faults`) | KV / Service Binding / D1 / Cache wrappers | "How does the Worker behave when its KV throws" |

**Common confusion:** `faults.status(500, ...)` from chaosbringer **does not produce server-side telemetry** — the route is intercepted in the browser, the server is never called. To see a fault inside the server's OTel trace, mount `@mizchi/server-faults` (or run both layers together).

## Features

- **Weighted random actions** targeted by ARIA role and visible text (nav links > buttons > inputs > scroll).
- **Thorough link extraction** — `<a>`, `<area>`, `<iframe>`, `<link rel="canonical"/"alternate">`, `<meta http-equiv="refresh">`, and **SPA `history.pushState` / `replaceState` navigations** all feed the queue, so React Router / Vue Router / SvelteKit / Next.js client-side routes get discovered without static `<a href>`.
- **Seeded reproducibility** — same seed, same action order. Every report prints a `Repro:` line you can paste into CI logs.
- **Network fault injection** via Playwright's route API: serve a 500, abort, or add latency to any URL pattern.
- **Lifecycle fault injection** — CDP CPU throttling, storage wipe (localStorage / sessionStorage / cookies / IndexedDB), Service Worker cache eviction, and key/value tampering, applied at named stages of every page visit (`beforeNavigation` / `afterLoad` / `beforeActions` / `betweenActions`).
- **Runtime fault injection** — persistent in-page monkey-patches installed via `addInitScript` on every navigation; subverts JS APIs that no network mock can reach: `reject-fetch` (TypeError or AbortError), `never-settle-fetch`, `reject-body` (`res.json()` rejects after the fetch resolved), `resolve-rejected-thenable`, `clock-skew`.
- **Deterministic fault schedules** — `schedule: { decisions: ["inject", "pass"] }` on any fault layer replaces the probability roll with a per-occurrence decision table, so "fail the first call, pass the retry" is a test rather than a lucky run. Consumes no RNG, so seeds stay stable.
- **Model-driven fault coverage** — a temporal-logic model (Quint / ITF) enumerates the failure space, `chaosbringer model compile` turns each witness into a committed `FaultPlan`, `model run` replays every state with the model as the oracle, and `model shrink` minimises a failing plan to the smallest schedule that still fails the same way. Reports which states are reachable, which are unreachable within the bound, and which plans the app never actually exercised.
- **Coverage-guided action selection** — opt-in V8 precise coverage feedback (CDP `Profiler.takePreciseCoverage`) attributes per-action coverage deltas to the target that fired them and biases subsequent action weights toward targets that historically delivered new code paths.
- **Declarative invariants** evaluated on every page. A violation fails the run regardless of `--strict`. Trans-page state — e.g. state-machine transitions — is supported via a run-scoped `ctx.state` Map and an `invariants.stateMachine()` helper.
- **Accessibility checks** via an `invariants.axe()` preset — axe-core is an optional peer dep.
- **Performance budgets** per TTFB / FCP / LCP / TBT — budget breaches fail the run.
- **Visual regression** via pixelmatch — compare per-page screenshots against baselines, fail on diff.
- **Error detection**: console errors, failed requests, JS exceptions, unhandled rejections, invariant violations.
- **Recovery from 404 / 5xx** — records what actions preceded the failure.
- **HAR record / replay** + **trace record / replay / minimize** for fully deterministic runs and delta-debugged repros.
- **Failure artifact bundles** — every failing page dumps a directory with screenshot, HTML, errors, trace prefix, and a `repro.sh` to replay it.
- **Baseline diff** — surface new clusters / newly failing pages vs a previous run.
- **Flake detection** — rerun the same crawl N times and flag clusters / pages whose outcome varies.
- **Action heatmap** — pure aggregation of `report.actions[]` exposing the most-hit and most-failed targets.
- **JUnit XML output** — Surefire-style `junit.xml` so any CI dashboard (Jenkins, CircleCI, GitLab, GitHub Actions test summary, Allure) can ingest the run.
- **Authenticated crawls** via Playwright storageState, **device emulation** (iPhone, Pixel, …), **network throttling** (slow-3g, fast-3g, offline).
- **Sitemap seeding** — prepend every URL in a sitemap.xml (or sitemap index) to the queue.
- **Parallel sharding** — split a crawl across N processes with `--shard i/N`, then merge via the `shard` subcommand.
- **GitHub Actions annotations** — emit `::error` / `::warning` lines so failures show up on the run summary.
- **Playwright Test integration** for when you'd rather run chaos inside an existing test file.
- **CLI** for running from a shell or CI, with `minimize` / `flake` / `shard` / `diff` / `parity` / `cluster-artifacts` / `recipes` / `load` subcommands.

## Install

```bash
pnpm add chaosbringer playwright @playwright/test
npx playwright install chromium
```

`chaosbringer` targets ESM. Programmatic consumers need `"type": "module"` (or `.mts` files) and `playwright` as a peer dependency.

### Installing from a git ref

`chaosbringer` is currently distributed via GitHub (no npm package yet). Both forms work:

```bash
# pin a commit SHA
pnpm add chaosbringer@github:mizchi/chaosbringer#<sha>

# track main
pnpm add chaosbringer@github:mizchi/chaosbringer
```

The package's `prepare` script runs `tsc` on install, so `pnpm install` / `npm install` builds `dist/` automatically — no manual step needed.

## Quick start — CLI

```bash
# Crawl, then exit 0 / 1 based on navigation outcomes
chaosbringer --url http://localhost:3000

# Dev mode: ignore third-party analytics noise
chaosbringer --url http://localhost:3000 --ignore-analytics

# CI mode: console errors and JS exceptions also fail the run
chaosbringer --url http://localhost:3000 --strict --compact --ignore-analytics

# Reproduce a failing run by pasting its Repro: line
chaosbringer --url http://localhost:3000 --seed 1234567 --max-pages 20
```

## Quick start — programmatic

The shortest path, using the `chaos()` convenience and the `faults` helpers:

```ts
// chaos-test.ts
import { chaos, faults } from "chaosbringer";

async function main() {
  const { report, passed } = await chaos({
    baseUrl: "http://localhost:3000",
    seed: 42,
    maxPages: 20,
    strict: true,
    faultInjection: [
      faults.status(500, { urlPattern: /\/api\// }),
      faults.delay(2000, { urlPattern: /\/slow\// }),
    ],
    invariants: [
      {
        name: "cart-count-non-negative",
        when: "afterActions",
        async check({ page }) {
          const n = Number(await page.locator("[data-cart-count]").textContent());
          return n >= 0 || `cart count was ${n}`;
        },
      },
    ],
  });

  console.log(report.reproCommand);
  process.exit(passed ? 0 : 1);
}
main();
```

The examples wrap in `async function main()` because a plain `.ts` file under an unconfigured project can't use top-level `await`.

### Lower-level API

If you need more control than `chaos()` exposes:

```ts
import { ChaosCrawler, getExitCode } from "chaosbringer";

async function main() {
  const crawler = new ChaosCrawler({
    baseUrl: "http://localhost:3000",
    seed: 42,
  });
  const report = await crawler.start();
  process.exit(getExitCode(report, /* strict */ true));
}
main();
```

## Reproducible runs

Every report includes:
- `report.seed` — the seed actually used (random if you didn't pass one).
- `report.reproCommand` — a shell-safe invocation that rebuilds the same run.

Both are printed in the compact header (`[PASS] … (seed=42)`) and the full report (`Seed: 42` / `Repro: chaosbringer --url … --seed 42`).

To rerun an exact failure locally, copy the `Repro:` line from CI.

## Fault injection

Fault rules let you force specific network requests to fail, delay, or return a canned response. Use the `faults` helpers to build rules without the discriminated-union noise:

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  faultInjection: [
    // Always 500 on /api/*
    faults.status(500, { urlPattern: /\/api\// }),

    // 30% of the time, return a 429 with a Retry-After body
    faults.status(429, {
      urlPattern: /\/api\/orders$/,
      methods: ["POST"],
      probability: 0.3,
      body: "Retry-After: 5",
      contentType: "text/plain",
    }),

    // Abort tracking pixels
    faults.abort({ urlPattern: /tracking/ }),

    // Add 2s of latency to one endpoint
    faults.delay(2000, { urlPattern: /\/api\/search/ }),
  ],
});
```

`probability` is evaluated against the seeded RNG — same seed, same pattern of injections.

> **Behaviour change:** `probability: 0` no longer draws from the RNG. It is a
> rule that can never fire, so rolling for it was a wasted draw — but the draw
> was part of the sequence, so **any existing seeded config containing a
> `probability: 0` fault rule now produces a different action sequence than it
> did before.** Parking a rule with `probability: 0` instead of deleting it is
> the ordinary way to do that, so if you have a pinned seed and a pinned
> expected action order, re-record it. `probability: 1` and values in `(0, 1)`
> are unaffected, and the lifecycle layer never drew for `0` in the first
> place. Nothing else about seed stability changed: RNG is consumed only for a
> `probability` strictly inside `(0, 1)`.

> **Behaviour change, the second one:** every rule's `urlPattern` is now
> `test()`ed against every request, where before the handler returned as soon
> as a rule injected. This is what lets two rules on the same URL agree about
> occurrence numbers, and it is invisible for a stateless pattern — but a
> RegExp carrying `g` or `y` has a `lastIndex` that `test()` writes, so an
> extra test used to renumber it. Those flags are now stripped when a matcher
> is compiled (your own RegExp object is left alone), which means a `/g`
> pattern matches what it reads as matching rather than firing on alternating
> requests. If you have a pinned expectation recorded against the old
> alternating behaviour, it will change — in the direction of what the pattern
> says.

### Deterministic schedules

`probability` cannot say "fail the first call, let the retry through". `schedule` can: a decision table indexed by how many times the rule has already matched.

```ts
faultInjection: [
  faults.status(500, {
    urlPattern: /\/api\/cart$/,
    schedule: { decisions: ["inject", "pass"] }, // 1st call 500s, retry works
  }),
],
```

- `afterEnd` decides what happens past the table: `"pass"` (default — spent), `"inject"` (keep firing), `"repeat"` (cycle it).
- Available on all four layers (`faultInjection`, `lifecycleFaults`, `runtimeFaults`, `iframeFaults`). `probability` + `schedule` together is a validation error.
- A schedule consumes no RNG, so adding one leaves the seed sequence — and therefore chaos action selection — untouched.
- Faults watching the same URL (or the same iframe) share occurrence numbering on **every** layer: each evaluates every matching rule, so occurrence 0 can get one fault kind and occurrence 2 another, and a rule that decided `inject` and lost the race is counted in `suppressed` rather than dropped. Don't split one endpoint across the network and runtime layers, though: a client-side rejection issues no request, so the network counter never advances.

To enumerate *every* combination rather than the ones you thought of, see [model-driven faults](https://github.com/mizchi/chaosbringer/blob/main/docs/recipes/model-driven-faults.md).

Per-rule `matched` / `injected` counters end up in `report.faultInjections`. When a rule's `matched` is `0` at the end of a run, chaosbringer emits a `fault_rule_unmatched` warning on the logger — useful for catching typo'd `urlPattern` regexes and rules that are shadowed by an earlier catch-all.

A third counter, `suppressed`, appears on a row only when it is non-zero. Rules are first-match-wins, but a *scheduled* rule advances its occurrence whenever its pattern matches — that is what lets two rules on one URL agree about what "occurrence 1" means. So a scheduled rule can decide `inject` and still not act, because a rule ahead of it answered the request. Without `suppressed` that reads as `matched: 3, injected: 0`, which is exactly what an all-`pass` schedule reports: a planned fault that did not happen, indistinguishable from one that was never planned. `RuntimeFaultStats` carries the same field for the same reason, and there `fired` counts effects, not decisions.

### Rule order: first match wins

Rules are evaluated **top-to-bottom** in the order you pass them, and the **first** match wins. This is the opposite of Playwright's raw `page.route(...)` API, where later registrations override earlier ones (LIFO). Put **specific rules first** and broad catch-alls last:

```ts
faultInjection: [
  // ✅ specific overrides first
  faults.status(200, {
    urlPattern: /^https:\/\/api\.example\.com\/p\//,
    body: '{"foo":"bar"}',
    name: "fulfill-api",
  }),
  // ✅ catch-all last
  faults.abort({ urlPattern: /^https?:\/\/(?!127\.0\.0\.1)/, name: "block-external" }),
],
```

If you reverse the order, the catch-all swallows every request and `fulfill-api` will show `matched: 0` in the report (and trigger the unmatched-rule warning described above). Chaosbringer also runs a best-effort static check at crawl start and emits one `fault_rule_shadowed` warning per shadowed pair — catching the common pathological case (broad regex before specific one) before the crawl has consumed a single request.

### Fault profiles

Hand-authored probabilities are easy to start with but hard to share. **Profiles** wrap operator knowledge — "S3 503 burst", "flaky third-party CDN", "regional degradation" — into a single function that returns a ready-made array of fault rules:

```ts
import { chaos, profiles } from "chaosbringer";

await chaos({
  baseUrl,
  faultInjection: [
    ...profiles.flakyThirdPartyCdn(/cdn\.example\.com/),
    ...profiles.s3FivexxBurst(/s3\.amazonaws\.com/),
    ...profiles.regionalDegradation({ urlPattern: /\/api\//, severity: 0.3 }),
    ...profiles.slowAuthService(/\/auth\//),
    ...profiles.partialDataLoss(/\/api\/feed/),
  ],
});
```

Available profiles (all return `FaultRule[]`):

| Profile | What it models |
|---|---|
| `flakyThirdPartyCdn(urlPattern)` | Slow + occasional drops on a third-party CDN |
| `s3FivexxBurst(urlPattern)` | Mostly 503 with a 500 sprinkle — retry-storm provocation |
| `regionalDegradation({ urlPattern, severity })` | Severity-scaled mix of slow / 5xx / drop. `severity` is clamped to `[0, 1]` |
| `slowAuthService(urlPattern, { ms?, rate? })` | One slow dependency. Defaults: 3000 ms, rate 0.5 |
| `partialDataLoss(urlPattern, { rate? })` | Empty 200 body + occasional 5xx — catches `JSON.parse(\"\")` bugs |

Each rule is named (`profile:behavior`), so per-profile counters land in `report.faultInjections` without extra wiring. Override knobs by passing options or compose `faults.*` directly when a profile doesn't fit.

## Trace correlation (W3C traceparent)

When the server is OTel-instrumented, it's useful to find the server-side trace that corresponds to a specific browser-driven action. Enable `traceparent: true` and chaosbringer will inject a fresh W3C `traceparent` header onto every request the browser sends:

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  traceparent: true,
});
```

To capture the generated trace IDs in your own report, pass an `onInject` hook:

```ts
const traceIds: Array<{ url: string; traceId: string }> = [];

await chaos({
  baseUrl: "http://localhost:3000",
  traceparent: {
    onInject: ({ url, traceId, existing }) => {
      // `existing` is true when the request already carried a traceparent
      // (e.g. set by an outer middleware) — chaosbringer never overwrites it.
      traceIds.push({ url, traceId });
    },
  },
});
```

The injected header is the standard `00-{trace-id}-{span-id}-01` format. Existing `traceparent` headers are honoured (passed through unchanged), so explicit upstream propagation always wins. The fault-injection layer also keeps the header attached, so a fault response and the matching server-side trace share the same correlation id.

## Pre-run setup hook

State-driven apps (CRUD, anything with a list) often start empty — the BFS frontier dries up at `pages=2` and `maxPages` becomes meaningless. `chaos({ setup })` runs **before** the crawler starts, in a disposable browser context, and gives you a `page` to seed backend state.

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  setup: async ({ page, baseUrl }) => {
    for (let i = 0; i < 5; i++) {
      await page.request.post(`${baseUrl}/api/todos`, {
        data: { title: `seed-${i}` },
        // pair with @mizchi/server-faults' bypassHeader to keep seeds out of the chaos surface
        headers: { "x-chaos-bypass": "1" },
      });
    }
  },
  // ... maxPages, faultInjection, etc.
});
```

The setup browser is closed before the crawler starts; carry shared state through the server (REST seed) or by saving `storageState` to a file and pointing `options.storageState` at it.

## Lifecycle faults (client-side)

`faultInjection` is request-scoped; **lifecycle faults** are page-scoped client-side perturbations that fire at well-defined stages of every page visit. Use them to simulate slow CPUs, stale auth tokens, evicted Service Worker caches, and other browser-side conditions that aren't expressible at the network layer.

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  lifecycleFaults: [
    // Throttle the CPU 4× before navigation, so the load itself is slow.
    faults.cpu(4),

    // Wipe localStorage + cookies right after the page loads.
    faults.clearStorage({ scopes: ["localStorage", "cookies"] }),

    // Drop every Service Worker cache before chaos clicks fire — only on /app/*.
    faults.evictCache({ urlPattern: /\/app\// }),

    // Replace the auth token with an expired value on the dashboard, with a
    // 50% probability per visit.
    faults.tamperStorage({
      scope: "localStorage",
      key: "auth_token",
      value: "expired",
      urlPattern: /\/dashboard/,
      probability: 0.5,
    }),
  ],
});
```

### Stages

Each lifecycle fault declares a `when` stage:

| Stage | Fires | Typical use |
| --- | --- | --- |
| `beforeNavigation` | Before `page.goto`. | CDP-level conditions that need to apply during the load (CPU throttle). |
| `afterLoad` | Right after navigation, before `afterLoad` invariants. | In-page mutations (storage wipes / tamper). |
| `beforeActions` | After `afterLoad` invariants, before chaos clicks. | One-shot evictions that should not affect invariants but should precede user simulation (Service Worker cache). |
| `betweenActions` | After every chaos action. | Sustained-pressure faults that need re-application across the action loop. |

Helpers default to a sensible stage per action kind (`cpu` → `beforeNavigation`, `clearStorage` / `tamperStorage` → `afterLoad`, `evictCache` → `beforeActions`); pass `when` to override.

### Action kinds

- **`faults.cpu(rate, opts?)`** — `rate` ≥ 1 multiplier (1 = no throttle, 4 ≈ 4× slower) applied via CDP `Emulation.setCPUThrottlingRate`.
- **`faults.clearStorage({ scopes, ... })`** — wipes one or more of `localStorage`, `sessionStorage`, `cookies`, `indexedDB`. Cookies are cleared at the BrowserContext level; the rest run in-page via `page.evaluate`.
- **`faults.evictCache(opts?)`** — drops entries from the Service Worker `caches` API. With no `cacheNames`, every cache is dropped.
- **`faults.tamperStorage({ scope, key, value, ... })`** — sets a single key in `localStorage` or `sessionStorage`. Useful for forcing logged-in apps into "stale auth token" / "corrupted client state" scenarios without touching the rest of storage.

### Common options

Every lifecycle helper accepts the same overrides:

| Option | Description |
| --- | --- |
| `when` | Override the helper's default stage. |
| `urlPattern` | Restrict the fault to URLs matching this regex / regex string. Omit to apply on every page. |
| `probability` | 0..1, default 1. Uses the crawler's seeded RNG so the firing pattern is reproducible. RNG is consumed only when `probability` is in `(0, 1)` — adding a probability-1 (or probability-0) fault doesn't shift the seed sequence for chaos action selection. Note that `probability: 0` **used to** consume a draw on the network layer; see the behaviour change above. |
| `name` | Override the auto-derived stats label (e.g. `cpu-throttle:4x`). |

### Stats

Every fault gets one row in `report.lifecycleFaults` with `matched` (URL-pattern matches), `fired` (post-probability), and `errored` (executor threw — e.g. SecurityError on opaque origins). Misbehaving faults are caught and counted; they never abort the rest of the crawl.

```json
{
  "lifecycleFaults": [
    { "name": "cpu-throttle:4x", "matched": 12, "fired": 12, "errored": 0 },
    { "name": "clear-storage:localStorage", "matched": 12, "fired": 6, "errored": 0 },
    { "name": "tamper-storage:localStorage.auth_token", "matched": 3, "fired": 1, "errored": 0 }
  ]
}
```

Like network-side fault injection, lifecycle faults are programmatic-only — they're not expressible as flat shell flags and so are absent from the CLI.

## Runtime faults (in-page monkey-patches)

`runtimeFaults` is a third fault layer, distinct from request-scoped `faultInjection` and stage-scoped `lifecycleFaults`. Each entry is a persistent monkey-patch installed via `addInitScript` on every page navigation, subverting in-page JS APIs so the app sees client-side failures that no network mock would expose.

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  runtimeFaults: [
    // 30% of fetch() calls reject with "Failed to fetch" before any
    // network round-trip — exposes Service Worker fallbacks, retry
    // logic, and "offline indicator" code paths.
    faults.flakyFetch({
      urlPattern: /\/api\//,
      probability: 0.3,
      rejectionMessage: "simulated network failure",
    }),
    // Skew the clock 25 minutes forward on /dashboard pages — surfaces
    // token-expiry and cache-bust bugs without waiting real time.
    faults.clockSkew(25 * 60_000, { urlPattern: /\/dashboard/ }),
  ],
});
```

Promise-shaped kinds, for the failure modes a network mock cannot express:

| Helper | What the app sees | Bug it exposes |
| --- | --- | --- |
| `faults.rejectFetch({ rejectAs })` | `fetch` rejects with a `TypeError` (default) or a `DOMException` named `AbortError` | Handlers that branch on `instanceof TypeError`; a retry banner shown on a user cancel |
| `faults.rejectBody()` | `fetch` resolves, then `res.json()` rejects | The classic missed `catch`: guarded fetch, unguarded `await res.json()` |
| `faults.neverSettleFetch()` | the promise never settles, no request is issued | Missing timeout. Because nothing is in flight, `networkidle` still fires — the UI simply never leaves loading |
| `faults.rejectedThenable()` | same rejection, one microtask later, via thenable assimilation | Handlers attached too late |

`faults.flakyFetch()` still works; it is `rejectFetch({ rejectAs: "TypeError" })`. One thing to know if you migrate: the stats label changes with it. An unnamed `flakyFetch` reported `rule: "flaky-fetch"` and the `rejectFetch` form reports `rule: "reject-fetch:TypeError"`, so anything matching on `report.runtimeFaults[].rule` needs updating — or pass an explicit `name` and stop depending on the derived one.

`faults.status(500, { urlPattern })` with no `body` does **not** send an empty body — the default is `{"error":500}` with `content-type: application/json`. That default decides which app bug a 500 finds: a client that skips `res.ok` and calls `res.json()` renders junk out of it and reports success, where an HTML or empty body makes `res.json()` *reject* and the client takes its error path (or leaks an unhandled rejection). Two different defects behind one status code, so both are worth testing; pass `body: ""` or `body: "<html>…"` explicitly for the second.

(The default was originally justified by a spurious `ERR_ABORTED` Chromium was said to emit alongside an empty intercepted body. That does not reproduce on Chromium 147 — no `requestfailed`, no ERR_ABORTED on any channel, the same single console line either way — so treat the body choice as being about your client's parsing path, not about browser noise.)

The network layer gains the matching `faults.hang({ urlPattern, releaseAfterMs })`: the request is held open and never answered. Without `releaseAfterMs` the route is parked and counted in `report.heldRequests`, then aborted when the run is done with the page: at teardown for a page the crawler owns, and before `testPage()` returns for one it does not (a parked route left behind would make the caller's *next* action on that page wait on a request nothing will ever answer). If you drive the page yourself across several steps, `crawler.release()` drains on demand.

Since the crawler navigates with `waitUntil: "networkidle"`, prefer hanging what an action fires *after* load, or set the bound.

Know what that costs before you read the report: a hang on a load-time request means `page.goto` spends its whole `timeout` and then throws, and that throw is recorded as a page error of type `exception` — so `summary.jsExceptions` reads 1 and an error cluster appears carrying Playwright's own timeout message. **The page threw nothing.** The classification is the crawler's, not the app's, and it is the expected outcome of the fault rather than a finding. `report.heldRequests` (now printed in the text report too) is the number that tells you which one you are looking at.

`never-settle-fetch` honours `init.signal`, which is what makes it a fair test of a bounded request rather than a way to fail every client. Note what the caller sees: under `AbortSignal.timeout(ms)` the rejection is a `TimeoutError`, not an `AbortError` — a `catch` branching only on `err.name === "AbortError"` misses it. An explicit `AbortController.abort()` still gives `AbortError`.

The probability roll is deterministic given the same `(seed, runtimeFaults)` pair — the in-page LCG is seeded from `seed` so two runs roll identically.

`urlPattern` means different things per kind: **fetch-scoped** kinds (`flaky-fetch`, `reject-fetch`, `never-settle-fetch`, `reject-body`, `resolve-rejected-thenable`) match the **request URL** passed to `fetch()`, per call; **page-scoped** kinds (`clock-skew`) match `location.href` once, when the init script installs.

Layer comparison:

| Layer | Where it runs | Targets | Example |
| --- | --- | --- | --- |
| `faultInjection` | Playwright `route()` (Node side) | individual network requests | serve 500 on `/api/*` |
| `lifecycleFaults` | per-page hook (CDP / page eval) | one-shot at named stages | wipe localStorage `afterLoad` |
| `runtimeFaults` | `addInitScript` (in-page) | persistent JS API patches | reject `fetch()`, skew `Date.now` |
| `iframeFaults` | `addInitScript` (in-page) | `HTMLIFrameElement.prototype.src` per matching iframe | delay / starve / mid-load-remove an iframe load |

Stats land in `report.runtimeFaults` — one row per fault with `matched` (URL filtered ok, probability about to roll) and `fired` (actually triggered) counts.

Like the other fault layers, `runtimeFaults` is programmatic-only.

## Iframe-load faults

Some classes of bugs only surface when a third-party library injects an iframe and the host page reacts to that iframe's load lifecycle — ad SDKs, embeddable widgets, checkout iframes, social plugins, video players. `faultInjection` operates on the request layer (requests *inside* the iframe) and `lifecycleFaults` operates on the *host* page lifecycle; neither can perturb the iframe element's own load as observed by the parent.

`iframeFaults` is a fourth fault layer that monkey-patches `HTMLIFrameElement.prototype.src` (and `setAttribute("src", ...)`) so faults fire the moment the host page assigns the iframe's URL — three primitives that no other layer can express:

```ts
import { chaos, faults } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  iframeFaults: [
    // Delay every ad iframe's load by 3s so the host library races a
    // visibility timer against the contained document arriving.
    faults.iframeLoadDelay(3000, { selector: "iframe.ad-slot" }),

    // 20% of the time, never fire `load` on the player iframe — swap to
    // about:blank so the host's onload-driven impression event is starved.
    faults.iframeNeverLoad({
      selector: "iframe[data-widget='player']",
      probability: 0.2,
    }),

    // 10% of the time, remove the iframe from the DOM 500ms after src
    // is set — exposes listener-teardown and pending-callback races.
    faults.iframeRemoveMidLoad({
      selector: "iframe",
      atMs: 500,
      probability: 0.1,
    }),
  ],
});
```

Selectors are matched via `iframe.matches(selector)` at the moment `src` is set. If the library does `iframe.src = "..."; container.appendChild(iframe);` (i.e. assigns `src` *before* attaching to the DOM), ancestor combinators like `#container iframe` won't match — prefer attribute / class selectors on the iframe itself (`iframe[data-widget]`, `iframe.ad-slot`).

Why not just `faults.delay({ urlPattern })`?

- `faults.delay` slows the request *inside* the iframe, which does delay the parent's `iframe.onload` — that case (iframe loads slowly) overlaps.
- But there's no way to express "iframe never fires `load`" via `route()` (the response body has to actually arrive).
- And there's no way to express "iframe removed mid-load" via `route()` at all — it's a DOM-side operation.

Stats land in `report.iframeFaults` — one row per fault with `selector`, `action`, `matched` (iframes whose selector matched), and `fired` (post-probability) counts. Like the other fault layers, `iframeFaults` is programmatic-only.

```json
{
  "iframeFaults": [
    { "rule": "iframe-load-delay:3000ms", "selector": "iframe.ad-slot", "action": "load-delay", "matched": 4, "fired": 4 },
    { "rule": "iframe-never-load", "selector": "iframe[data-widget='player']", "action": "never-load", "matched": 2, "fired": 1 }
  ]
}
```

## Invariants

Invariants are assertions that must hold on every page. They run either `afterLoad` (right after navigation) or `afterActions` (default — after chaos clicks/inputs). Returning `false`, throwing, or returning a string all count as a failure; returning `true` or `void` means the invariant held.

```ts
import { chaos, type Invariant } from "chaosbringer";

const invariants: Invariant[] = [
  {
    name: "has-h1",
    when: "afterLoad",
    async check({ page }) {
      return (await page.locator("h1").count()) > 0 || "no <h1>";
    },
  },
  {
    name: "no-loading-spinner-after-actions",
    urlPattern: /\/spa\//,
    async check({ page }) {
      const t = (await page.locator("#app").textContent()) ?? "";
      return !/loading/i.test(t) || `app still shows loading: "${t}"`;
    },
  },
];

const { passed } = await chaos({ baseUrl: "http://localhost:3000", invariants });
```

Violations always fail the run (exit 1), whether or not `strict` is set — a declared invariant is a stronger signal than console noise.

### Trans-page state — `ctx.state`

Each invariant's `check()` receives a `ctx.state: Map<string, unknown>` shared with every other invariant on every page. The same instance is passed for the lifetime of one `crawler.start()` call and reset on the next, so invariants can carry data across pages and flag regressions that need history (monotonic counters, set-membership, ordered events).

```ts
const cartCountMonotonic: Invariant = {
  name: "cart-monotonic-after-add",
  when: "afterActions",
  async check({ page, state }) {
    const n = Number((await page.locator("[data-cart-count]").textContent()) ?? "0");
    const prev = (state.get("cart:max") as number | undefined) ?? 0;
    if (n + 1 < prev) {
      // Allow one decrement to model a removed item; flag larger drops.
      return `cart count went from ${prev} to ${n}`;
    }
    state.set("cart:max", Math.max(prev, n));
  },
};
```

Use `state.set` / `state.get` directly, or build on top via `stateMachine()` below.

### State-machine invariants

For discrete app modes (`anonymous` → `logged-in` → `in-checkout` → `purchased`), `invariants.stateMachine()` compiles down to a regular `Invariant` that detects illegal transitions across pages.

```ts
import { chaos, invariants } from "chaosbringer";

type Auth = "anonymous" | "logged-in" | "in-checkout" | "purchased";

const auth = invariants.stateMachine<Auth>({
  name: "auth-flow",
  initial: "anonymous",
  // Self-loops are legal automatically. Terminal states have no outgoing edges.
  transitions: {
    anonymous: ["logged-in"],
    "logged-in": ["anonymous", "in-checkout"],
    "in-checkout": ["logged-in", "purchased"],
    // `purchased` left out → terminal: leaving it is illegal.
  },
  // Run after chaos clicks so post-action page state is reflected.
  when: "afterActions",
  async derive({ page }) {
    if (await page.locator("[data-receipt]").count() > 0) return "purchased";
    if (await page.locator("[data-checkout-step]").count() > 0) return "in-checkout";
    if (await page.locator("[data-user-id]").count() > 0) return "logged-in";
    return "anonymous";
  },
});

await chaos({ baseUrl: "http://localhost:3000", invariants: [auth] });
```

When `derive()` returns a label that the previous label's transition list doesn't allow, the invariant fails with `illegal transition "<prev>" → "<next>" (allowed: …)` — surfaced as a regular `invariant-violation` PageError, clustered like any other.

`derive()` receives `{ page, url, prev, errors }` so the caller can branch on the previous label or the current URL when classifying the page.

The state-machine helper is one preset on top of `ctx.state`; for non-discrete properties (counters, set membership, ordered event log), drop down to a plain `Invariant` and use `state.set` / `state.get` directly.

## Coverage-guided action selection

`coverageFeedback` opts the crawler into AFL-style feedback: V8 precise coverage (CDP `Profiler.startPreciseCoverage` / `takePreciseCoverage`) is collected per page, the coverage delta of every chaos action is attributed to the action target that fired it, and on subsequent visits each target's weight is multiplied by `1 + boost · log1p(score)`. Targets that have historically delivered new V8 functions get picked more often; dead-end targets fade.

```ts
import { chaos } from "chaosbringer";

const { report } = await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  maxPages: 50,
  maxActionsPerPage: 5,
  coverageFeedback: { enabled: true, boost: 2 },
});

console.log(report.coverage);
// {
//   totalFunctions: 312,
//   pagesWithNewCoverage: 18,
//   topNovelTargets: [
//     { url: "http://localhost:3000/cart", selector: "button:has-text(\"Checkout\")", score: 47 },
//     { url: "http://localhost:3000/", selector: "[role=link]:has-text(\"Sign in\")", score: 23 },
//     ...
//   ],
// }
```

| Option | Description | Default |
| --- | --- | --- |
| `enabled` | Master switch — attaches the coverage collector and biases weights. | required (`false` if omitted entirely) |
| `boost` | Multiplier applied via `1 + boost · log1p(score)`. `0` keeps coverage tracked but disables the weight bias. `2` is moderate. `4`+ aggressively concentrates picks. | 2 |
| `topN` | Cap top-N novel targets emitted in `report.coverage`. | 20 |

### Reproducibility

The collector never consumes the seeded RNG, so the seed sequence is unchanged. Action selection still differs vs a no-feedback run because the **weight inputs** to `weightedPick` are different — reproducibility is now `(seed, coverageFeedback)` rather than `seed` alone. The `Repro:` line emitted by the report only encodes flags expressible on the CLI, so a coverage-feedback run is reproducible programmatically (same `chaos({...})` config) but not from the CLI alone.

### Cost

Each chaos action incurs one `Profiler.takePreciseCoverage` CDP roundtrip. Chromium-only (the API is Chrome-DevTools-Protocol-specific). For typical chaos runs (≤100 pages, ≤5 actions per page) the overhead is below 5%; expect a noticeable slowdown on heavy SPAs with hundreds of scripts.

## Device emulation & network throttling

Emulate mobile devices or throttle the network to catch bugs that only surface on slow connections or small viewports.

```bash
chaosbringer --url http://localhost:3000 --device "iPhone 14" --network slow-3g
```

- `--device <name>` — any Playwright device descriptor (`iPhone 14`, `Pixel 7`, `iPad Pro 11`, `Desktop Chrome`, …). Sets viewport, user-agent, device pixel ratio, mobile / touch flags via `newContext({ ...devices[name] })`. Unknown names fail validation up-front.
- `--network <profile>` — `slow-3g`, `fast-3g`, or `offline`. Attaches a CDP session per page and calls `Network.emulateNetworkConditions` with the same values Chrome DevTools' presets use.

Combining the two lets you measure perf budgets under realistic conditions: `chaosbringer --url … --device "Pixel 7" --network slow-3g --budget lcp=4000`.

## Sitemap seeding

Prepend every URL in a sitemap.xml (or sitemap index) to the crawl queue — essential for sites whose nav is JS-rendered and so gets missed by DOM link extraction.

```bash
chaosbringer --url https://docs.example.com --seed-from-sitemap https://docs.example.com/sitemap.xml
```

Accepts a URL or a local path. Sitemap indexes are followed breadth-first; referenced URLs outside the baseUrl origin are dropped to avoid wasting visit budget. A runaway index (suspected cycle) fails fast.

```ts
import { fetchSitemapUrls } from "chaosbringer";
const urls = await fetchSitemapUrls("https://docs.example.com/sitemap.xml");
```

## Authenticated crawls (storage state)

To crawl pages behind a login, point chaosbringer at a Playwright `storageState` file — the JSON containing cookies + localStorage that a logged-in browser context produces. Run a one-off login script once, save the state, then reuse it for every chaos run.

```ts
// auth-setup.ts — run once, or as a Playwright global setup
import { chromium } from "playwright";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("http://localhost:3000/login");
await page.getByLabel("Email").fill("ci@example.com");
await page.getByLabel("Password").fill(process.env.TEST_PASSWORD!);
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL("**/dashboard");
await context.storageState({ path: "auth.json" });
await browser.close();
```

```bash
# Chaos-test the authenticated surface
chaosbringer --url http://localhost:3000/dashboard --storage-state auth.json
```

```ts
await chaos({
  baseUrl: "http://localhost:3000/dashboard",
  storageState: "auth.json",
});
```

The file is read by Playwright and not modified by the crawl. If the session expires mid-run, you'll see auth-redirect pages surface as errors — regenerate the state file and rerun.

## HAR record / replay

Chaosbringer can capture network traffic to a HAR file on one run and replay it on the next. A replay run is deterministic even if the backend is flaky — every request that was in the HAR gets served from the HAR, not the network.

```bash
# First run: capture responses
chaosbringer --url http://localhost:3000 --seed 42 --har-record chaos.har

# Later: replay without the server running
chaosbringer --url http://localhost:3000 --seed 42 --har-replay chaos.har
```

Programmatic:

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  har: { path: "chaos.har", mode: "record" },
});

// Replay
await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  har: { path: "chaos.har", mode: "replay", notFound: "abort" },
});
```

- `notFound: "fallback"` (default) lets unmatched URLs fall through to the real network.
- `notFound: "abort"` fails them — useful when you want to prove a run is fully deterministic.
- Fault injection rules still apply in replay mode and take precedence over HAR responses.

> **Heads up — `notFound: "abort"` with `traceparent` injection:** when
> `traceparent` is enabled, every outgoing request carries a freshly-generated
> `traceparent` header that wasn't in the recorded HAR. Depending on your
> Playwright version and HAR matcher, this can cause `notFound: "abort"` to
> fail on every request during replay. If you hit this, either record the HAR
> with `traceparent` also enabled (so the matcher sees consistent headers),
> set `traceparent: false` for replay-mode runs, or use `notFound: "fallback"`.

## Accessibility (axe-core)

Install `axe-core` as a peer and opt in with either the `invariants.axe()` preset or the `--axe` flag. Each visited page is scanned; violations are reported as invariant failures (name: `a11y-axe`), which always fail the run.

```bash
pnpm add axe-core
chaosbringer --url http://localhost:3000 --axe
chaosbringer --url http://localhost:3000 --axe --axe-tags wcag2aa,best-practice
```

```ts
import { chaos, invariants } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  invariants: [
    invariants.axe({
      tags: ["wcag2aa"],
      exclude: [".third-party-widget"],
      disableRules: ["color-contrast"],
    }),
  ],
});
```

`axe-core` is an optional peer dependency — the preset fails with a clear install hint if it isn't present. The preset is thin; drop to a custom invariant if you need multiple axe runs per page, per-URL rule overrides, or full-result capture (passes / incomplete).

A failing scan is rendered on one line: `[a11y-axe] 3 a11y violations: color-contrast(×5, serious), image-alt(×2, critical), region(×1)`. Because violations cluster by their fingerprint, a11y regressions show up in the baseline diff just like any other invariant.

## Action heatmap

Aggregate `report.actions[]` into per-target stats — count, success rate, blocked-external count, shard-skipped count — sorted by frequency. Useful when you want to know which targets the chaos driver is hitting most and which ones disproportionately fail.

```bash
chaosbringer --url http://localhost:3000 --heatmap --heatmap-top 30
chaosbringer --url http://localhost:3000 --heatmap-out heatmap.json
```

```ts
import { buildActionHeatmap, formatHeatmap, chaos } from "chaosbringer";

const { report } = await chaos({ baseUrl: "http://localhost:3000" });
const entries = buildActionHeatmap(report.actions);
console.log(formatHeatmap(entries, 20));
// entries is sorted by count desc, then failureCount desc, then key asc.
```

It's pure aggregation over the existing `actions` array — works on any report (current run, baseline, or one loaded from disk). Action types remain distinct, so `click Search` and `input Search` count separately.

## JUnit XML output

Render the report as Surefire-style `junit.xml` so existing CI dashboards (Jenkins, CircleCI, GitLab CI, GitHub Actions test summaries, Allure) ingest chaosbringer runs without bespoke parsing.

```bash
chaosbringer --url http://localhost:3000 --junit junit.xml
```

```ts
import { buildJunitXml, chaos } from "chaosbringer";
import { writeFileSync } from "node:fs";

const { report } = await chaos({ baseUrl: "http://localhost:3000" });
writeFileSync("junit.xml", buildJunitXml(report, { suiteName: "smoke" }));
```

Mapping is one `<testcase>` per visited page:

- `status="error"` / `"timeout"` → `<error>` (HTTP code or `timeout` in `type`)
- `status="success"` with `errors[].length > 0` → `<failure>` (concatenates all PageError entries)
- otherwise → passing testcase, no children

Test names strip the `baseUrl` prefix so `/docs/intro` shows up rather than the full URL. Special XML chars (`< > & " '`) in messages and URLs are escaped.

## Visual regression

Compare each page's screenshot against a baseline PNG on disk. Differences beyond the configured budget are recorded as invariant violations (`visual-regression`), which fail the run.

```bash
# First run: baselines don't exist yet — chaosbringer records them and passes.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__

# Subsequent runs: compare against the recorded baselines.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__ \
  --visual-max-diff-pixels 100 \
  --visual-diff-dir ./__diffs__

# After an intentional UI change, overwrite the baselines.
chaosbringer --url http://localhost:3000 --visual-baseline ./__snapshots__ --visual-update
```

```ts
import { chaos, invariants } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  invariants: [
    invariants.visualRegression({
      baselineDir: "./__snapshots__",
      threshold: 0.1,          // pixelmatch color distance (0..1)
      maxDiffPixels: 100,      // absolute tolerance
      maxDiffRatio: 0.001,     // or proportional tolerance
      diffDir: "./__diffs__",
    }),
  ],
});
```

- Baseline filenames are derived from each page's URL (path + query, sanitized) so different routes don't collide.
- `pixelmatch` and `pngjs` are optional peer deps — install them explicitly (`pnpm add pixelmatch pngjs`). The invariant fails with a clear install hint when they're missing.
- Dimension mismatches between baseline and current are treated as full-diff failures — resize or re-record the baseline intentionally rather than auto-accepting.
- Takes `fullPage: true` screenshots by default. Flip to viewport-only via `fullPage: false` in the programmatic API if your layout is sensitive to scroll position.
- Pair with `--device iPhone 14` to record device-specific baselines; the baseline dir is per-crawl so split baselines across devices by using different dirs.

## Failure artifact bundles

When a page errors, times out, recovers from a 4xx/5xx, or surfaces an invariant violation, the crawler can dump a self-contained bundle so the failure is reproducible without re-running the whole crawl.

```bash
chaosbringer --url http://localhost:3000 --failure-artifacts ./failures
```

```ts
import { chaos } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  failureArtifacts: { dir: "./failures", maxArtifacts: 50 },
});
```

Each failing page becomes a numbered subdirectory under `--failure-artifacts <dir>`:

```
failures/0000__checkout_review__a91c2f0e/
├── screenshot.png   # full-page PNG at the moment of failure
├── page.html        # `await page.content()` snapshot
├── errors.json      # full PageError[] (console / exception / network / invariant)
├── trace.jsonl      # meta + visits + actions, sliced up to and including this page
├── repro.sh         # `chaosbringer --url <base> --trace-replay ./trace.jsonl`
└── info.json        # URL, status, sourceUrl, recovery, seed, timestamps
```

`repro.sh` is executable — `cd` into the bundle and run it to replay the same sequence locally. Combine with `--strict` or `--baseline` to gate CI on the same shape of failure.

`maxArtifacts` caps the bundle count per run for runs that produce many failures (default: unlimited). Per-artifact opt-outs are available programmatically (`saveScreenshot: false`, `saveHtml: false`, `saveTrace: false`) when bundle size matters more than completeness.

## Performance budget

Declare a per-metric budget (in ms). Any page whose measured metric exceeds its limit is recorded as an invariant violation (`perf-budget.<metric>`), which fails the run just like any other invariant.

```bash
# CLI — comma-separated pairs, or repeat the flag
chaosbringer --url http://localhost:3000 --budget ttfb=200,fcp=1800,lcp=2500
```

```ts
await chaos({
  baseUrl: "http://localhost:3000",
  performanceBudget: { ttfb: 200, fcp: 1800, lcp: 2500 },
});
```

Supported keys: `ttfb`, `fcp`, `lcp`, `tbt`, `domContentLoaded`, `load`. Omitted keys are not enforced. Metrics that weren't captured (e.g. `lcp` on a page that didn't render anything large) don't produce violations — only observed-and-over-limit cases do.

Budget violations are clustered by metric name, so `perf-budget.lcp` firing on 20 pages shows up as one cluster with `count: 20` in the report and the baseline diff.

## Trace record / replay / minimize

For failures that are hard to diagnose from a seed alone, record the exact sequence of visits + actions to a JSONL file, then replay or minimize that sequence.

```bash
# Record
chaosbringer --url http://localhost:3000 --seed 42 --trace-out chaos.trace.jsonl

# Replay the exact sequence (no RNG, no discovery)
chaosbringer --url http://localhost:3000 --trace-replay chaos.trace.jsonl

# Shrink the trace to the minimum subsequence that still reproduces a failure
chaosbringer minimize --url http://localhost:3000 \
  --trace chaos.trace.jsonl \
  --match "Cannot read properties of undefined" \
  --trace-out min.trace.jsonl
```

A trace is line-delimited JSON: a leading `meta` entry with the seed + baseUrl, then alternating `visit` and `action` lines. Each `action` carries the selector that was clicked (or the scroll amount, or the input target), so replay can locate the same element in a fresh page. The format version is tracked — parsing refuses traces written by incompatible future versions rather than silently misinterpreting them.

Replay skips link discovery and the RNG entirely: only URLs listed as `visit` entries are loaded, and only the recorded actions are performed. Missing selectors are logged as failed actions and the run continues.

`minimize` drives repeated replays via delta debugging (ddmin) — it keeps removing action entries and re-running as long as `--match` still fires against an error cluster. Output goes to `--trace-out` (defaults to `min.trace.jsonl`).

## Baseline diff (regression detection)

Pass a previous report to `--baseline` and the current run is diffed against it — new error clusters and newly failing pages are surfaced separately from ones that were already broken.

```bash
# First run: writes chaos-report.json as usual (no baseline yet, warns and continues)
chaosbringer --url http://localhost:3000 --baseline chaos-report.json

# Subsequent runs: compare against the prior report
chaosbringer --url http://localhost:3000 --baseline chaos-report.json --baseline-strict
```

- `--baseline <path>` — diff against this report. A missing file produces a warning, not an error (the run still writes its own report so a later invocation has a baseline to compare against).
- `--baseline-strict` — exit 1 when the diff contains new clusters or newly failing pages. Resolved / unchanged entries never fail the run.

Programmatic:

```ts
import { chaos } from "chaosbringer";

const { report, passed } = await chaos({
  baseUrl: "http://localhost:3000",
  baseline: "chaos-report.json",
  baselineStrict: true,
});

for (const c of report.diff?.newClusters ?? []) {
  console.log(`NEW [${c.type}]×${c.after}: ${c.fingerprint}`);
}
```

Clusters are matched by the same fingerprint used for `errorClusters` (URL / line:col / long numeric ids stripped), so `HTTP 500 on /api/users/42` and `HTTP 500 on /api/users/99` collapse to the same entry. Pages are matched by URL.

## GitHub Actions annotations

Opt in with `--github-annotations` and chaosbringer prints a [workflow command](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) for every error cluster and dead link. GitHub surfaces these on the Checks tab alongside test output.

```bash
chaosbringer --url http://localhost:3000 --strict --github-annotations
```

Severity maps from cluster type: invariants / exceptions / network errors / crashes are `::error`, console errors and unhandled rejections are `::warning` (upgraded to error under `--strict`). Dead links always annotate as error with the source page in the message.

## Model-driven fault coverage

Probability sampling tells you what fired; it cannot tell you what was never
attempted. A temporal-logic model (Quint, or anything emitting ITF) enumerates
the failure space instead, and each enumerated state replays as one
deterministic run with the model's prediction as the oracle:

```bash
# dev-time: ITF witnesses -> committed plan files (pure Node)
chaosbringer model compile --traces model/traces --out model/plans

# CI: replay every plan, check every oracle (no Quint, no JVM)
chaosbringer model run --plans model/plans --url http://localhost:3000 \
  --config model/bridge.mjs
```

```
=== MODEL COVERAGE ===
States: 16/18 reachable (depth <= 4), 2 unreachable
Plans run: 16
Mismatches: 13
  [unhandledRejection] cart-fulfilled__shipping-rejected: a rejection escaped every handler, which the model's contract forbids
  [ui] cart-hung__shipping-fulfilled: model predicted ui="error", page reported "stuck"
```

Programmatic equivalent: `compilePlan` / `runPlans` / `aggregateCoverage`,
exported from the package root. The runner checks three things per plan — the
UI label via your `uiProbe`, whether a rejection escaped, and whether the
planned faults actually fired (a plan whose request the app never issues is
reported, not counted as a pass).

A checker returns the first counterexample it reaches, not the smallest, so a
failing plan is routinely longer and harsher than the bug. `model shrink`
minimises one:

```bash
chaosbringer model shrink --plan model/plans/refresh-storm.plan.json \
  --url http://localhost:3000 --config model/bridge.mjs --out min.plan.json
```

```
2 step(s) -> 1 over 5 run(s), preserving unhandledRejection
1-minimal: every remaining edit was tried and none of them still fails.
```

It drops steps that do not matter, weakens outcomes that need not be that
strong (`hang` → `status`), and lowers occurrences that need not be that late
— every candidate a real run judged by the same oracle, so the minimum
provably still fails, and the *same* way: a candidate that breaks differently
is a different finding and is rejected.

Only **contract** findings can be shrunk — an escaping rejection, a
`uiInvariant` violation. `expect.ui` and `expect.state` are what the *model*
predicted for that exact schedule, and a smaller schedule has no recomputed
prediction, so shrinking on them would "minimise" a plan to one that injects
nothing and still call it a reproduction. Those exit 1 with
`schedule-relative` rather than being answered wrongly. Likewise the search
exits 0 only when it actually finished: running out of runs, or hitting a
candidate the oracle could not judge, exits 1 and says which, because a
minimum nobody established is not a minimum. `shrinkPlan` is the exported
equivalent.

Full walkthrough: [model-driven faults](https://github.com/mizchi/chaosbringer/blob/main/docs/recipes/model-driven-faults.md).
Runnable: [`examples/model-faults/`](https://github.com/mizchi/chaosbringer/tree/main/examples/model-faults).

## Error clustering

`CrawlReport.errorClusters` collapses repeated errors so a run with 100 identical `console.error("Failed to load X")` calls surfaces as one cluster line with `count: 100`. Each cluster is keyed by `type` + a normalised fingerprint (URLs, line:col, and long numeric ids stripped).

```
ERROR CLUSTERS
  [console]×42 [5 urls] Failed to load resource: the server responded with a status of <n> (Not Found)
  [exception]×3 fixture: boom
```

Use it to triage noisy fuzz runs — high-count clusters are the first thing to look at.

## Exit codes

| Condition | Exit |
| --- | --- |
| No navigation errors, no invariant violations | **0** |
| At least one page with `status: "error"` or `"timeout"` | **1** |
| At least one invariant violation (any mode) | **1** |
| `--strict` and any console error / JS exception / **unhandled rejection** | **1** |

`chaos()` returns `{ passed, exitCode }`; the CLI applies the same rule via `getExitCode`.

> **Behaviour change:** `--strict` now also fails on an unhandled rejection. It
> used to ignore them, so a run whose entire finding was "the app left a
> rejection unhandled" exited 0 while a single `console.error` exited 1 — and
> an escaping rejection is the failure mode this library's Promise fault kinds
> exist to produce. If you were running `--strict` over a page with a known
> unhandled rejection, that run now fails; add the pattern to
> `ignoreErrorPatterns`, or fix it.

## Playwright Test integration

Use the pre-configured `chaosTest`:

```ts
import { chaosTest, chaosExpect } from "chaosbringer";

chaosTest("chaos-test homepage", async ({ page, chaos }) => {
  await page.goto("http://localhost:3000");
  const result = await chaos.testPage(page, page.url());
  chaosExpect.toHaveNoExceptions(result);
  chaosExpect.toLoadWithin(result, 3000);
});
```

Or extend your existing test:

```ts
import { test as base } from "@playwright/test";
import { withChaos, type ChaosFixtures } from "chaosbringer";

const test = base.extend<ChaosFixtures>(
  withChaos({ maxActionsPerPage: 10, ignoreErrorPatterns: ["analytics"] }),
);

test("my feature", async ({ page, chaos }) => {
  await page.goto("/dashboard");
  const result = await chaos.testPage(page, page.url());
  chaos.expectNoErrors(result);
});
```

Or crawl from within a fixture-based test:

```ts
chaosTest("crawl entire site", async ({ chaos }) => {
  const report = await chaos.crawl("http://localhost:3000");
  chaos.expectNoErrors(report);
  chaos.expectNoDeadLinks(report);
});
```

`expectNoDeadLinks` / `chaosExpect.toHaveNoDeadLinks` surface each broken URL together with the page it was found on, so a CI failure points straight at the broken anchor without cross-referencing the full JSON report.

## Subcommands

### `minimize`

Shrink a recorded trace to the minimum subsequence of actions that still reproduces a failure. Drives ddmin (delta debugging) by repeatedly running the crawler in replay mode with subsets of the recorded actions; the reproduction predicate matches an error cluster fingerprint against a regex.

```bash
chaosbringer minimize \
  --url http://localhost:3000 \
  --trace chaos.trace.jsonl \
  --match "Cannot read properties of undefined" \
  --trace-out min.trace.jsonl
```

`--max-pages`, `--timeout`, `--ignore-analytics` are forwarded to each replay. `min.trace.jsonl` is the default output path. Visit entries are preserved — only action entries are candidates for removal.

### `flake`

Run the same crawl N times and separate error clusters into stable (fire every run) vs flaky (fire in some runs but not others); pages are split the same way by failed / clean outcome. Useful for triaging whether a failure is a real bug or a race.

```bash
chaosbringer flake --url http://localhost:3000 --runs 5 --seed 42
```

With a fixed `--seed`, RNG-driven variance is impossible, so any flake points at non-determinism outside chaosbringer (server, network, timers, or observable ordering). Pair with `--har-replay` or `--trace-replay` to narrow further. Exits 1 when any cluster / page flaked, so CI can gate on it. `--output <path>` also writes the analysis as JSON.

Programmatic equivalent — `chaos()` does **not** throw when `strict: true` triggers a failure; it returns `{ report, passed: false, exitCode: 1 }`. That means you can collect reports across runs even with `strict: true` and pass them to `flakeReport()`:

```ts
import { chaos, flakeReport } from "chaosbringer";

const reports = [];
for (const seed of [1, 2, 3, 4, 5]) {
  const { report } = await chaos({ ...sharedOpts, seed, strict: true });
  reports.push(report);
}
const analysis = flakeReport(reports);
```

### `shard`

Split a crawl across N processes and merge the reports. Each worker is spawned with `--shard i/N` and hashes discovered URLs (FNV-1a) mod N; it only processes URLs whose hash matches its index, so shards do disjoint work. `baseUrl` is always processed by every shard so each has a seed for BFS.

```bash
chaosbringer shard \
  --count 4 \
  --url http://localhost:3000 \
  --seed-from-sitemap http://localhost:3000/sitemap.xml \
  --output chaos-report.json
```

All non-shard options (`--url`, `--max-pages`, `--seed`, `--baseline`, `--strict`, …) are forwarded verbatim to each worker. For full URL-space coverage, pair with `--seed-from-sitemap` — each shard filters the sitemap URLs by hash, so every URL is processed by exactly one shard. Without a sitemap, each shard only explores the subgraph reachable via owned links; deep pages reachable only through non-owned parents may go unvisited.

Exit code is the max of any worker's exit code and the merged report's (`--strict` / `--baseline-strict`). A single worker's non-zero exit still fails the overall run, even if the merged report looks clean.

You can also run shards by hand (e.g. as separate CI matrix jobs):

```bash
chaosbringer --url ... --shard 0/4 --output shard-0.json
chaosbringer --url ... --shard 1/4 --output shard-1.json
# ... then merge in Node / TS:
import { mergeReports } from "chaosbringer";
const merged = mergeReports([r0, r1, r2, r3]);
```

### `diff`

Compare two independent crawl reports. Surfaces clusters that fire only on the left, only on the right, and on both (likely third-party noise). Designed for the dual-runtime regression workflow where the same site data is served by two runtimes and crawled with the same seed.

```bash
chaosbringer --url http://127.0.0.1:3000 --seed 1 --output left.json
chaosbringer --url http://127.0.0.1:3001 --seed 1 --output right.json
chaosbringer diff left.json right.json
```

Flags: `--json` (machine output), `--shared-only` / `--left-only` / `--right-only` (filtered views for piping into wrapper scripts). Distinct from the `--baseline` flag, which assumes a directional baseline-vs-current comparison.

### `parity`

Non-random side-by-side HTTP probe. For each path in a file, GETs the same path against two base URLs and surfaces status mismatches, redirect-target mismatches, and one-side-only fetch failures. Use this when random crawls produce too much third-party noise to isolate route divergence.

```bash
chaosbringer parity \
  --left http://127.0.0.1:3000 \
  --right http://127.0.0.1:3001 \
  --paths paths.txt \
  --output parity.json
```

Default mode is manual redirects (compare 3xx + Location directly — the most sensitive mode for routing-bug detection). `--follow-redirects` falls back to final-status comparison. Fetch-based only — JS exceptions / body predicates would need a Playwright session per probe and are out of scope. Exits non-zero on any mismatch so it slots into CI as a gate.

### `cluster-artifacts`

Walks a report's `errorClusters` and emits one representative artifact bundle per cluster — copying `page.html` / `trace.jsonl` / `repro.sh` / screenshot from the matching per-page failure bundle and writing a filtered `errors.json` (only the cluster's own errors, not the whole page's). Triage-friendly: a cluster with 30 pages produces one directory the reviewer skims.

```bash
# Post-hoc: against an already-written failure-artifacts directory.
chaosbringer cluster-artifacts chaos-report.json --bundle-dir ./artifacts

# Inline: hook the main crawl so cluster bundles are emitted at the end.
chaosbringer --url http://localhost:3000 \
  --failure-artifacts ./artifacts \
  --cluster-artifacts \
  --cluster-min-count 5
```

`--min-count` (or `--cluster-min-count` inline) filters low-frequency noise. The inline form requires `--failure-artifacts` since it copies from the per-page bundles.

## CLI reference

| Option | Description | Default |
| --- | --- | --- |
| `--url <url>` | Base URL (required) | — |
| `--max-pages <n>` | Max pages visited | 50 |
| `--max-actions <n>` | Max random actions per page | 5 |
| `--timeout <ms>` | Page load timeout | 30000 |
| `--no-headless` | Show the browser window | headless |
| `--screenshots` | Take screenshots | false |
| `--screenshot-dir <path>` | Screenshot directory | `./screenshots` |
| `--output <path>` | Report path | `chaos-report.json` |
| `--exclude <pattern>` | Skip URLs matching regex (repeatable) | — |
| `--ignore-error <pattern>` | Suppress errors matching regex (repeatable) | — |
| `--ignore-analytics` | Suppress common analytics noise† | false |
| `--spa <pattern>` | Mark matching URLs as SPA (errors bucketed separately, repeatable) | — |
| `--log-file <path>` | JSON execution log | — |
| `--log-level <level>` | `debug` / `info` / `warn` / `error` | info |
| `--log-console` | Also log to console | false |
| `--seed <n>` | Seed for deterministic action selection | random |
| `--har-record <path>` | Capture network traffic to a HAR file | — |
| `--har-replay <path>` | Replay network traffic from a HAR file | — |
| `--storage-state <path>` | Playwright storageState JSON for authenticated crawls | — |
| `--budget <k=ms,...>` | Per-metric performance budget (repeatable) | — |
| `--axe` | Enable axe-core a11y scan on every page (requires `axe-core` installed) | false |
| `--axe-tags <list>` | Comma-separated axe tags | `wcag2a,wcag2aa,wcag21a,wcag21aa` |
| `--visual-baseline <dir>` | Enable visual regression against PNG baselines in `<dir>` (requires `pixelmatch` + `pngjs`) | — |
| `--visual-threshold <n>` | pixelmatch color distance (0..1) | 0.1 |
| `--visual-max-diff-pixels <n>` | Absolute pixel budget before failing | 0 |
| `--visual-max-diff-ratio <n>` | Ratio pixel budget (0..1) | — |
| `--visual-diff-dir <dir>` | Write diff PNGs here on failure | — |
| `--visual-update` | Overwrite baselines with current screenshots (for intentional UI updates) | false |
| `--failure-artifacts <dir>` | Per-failure bundle (screenshot + html + errors + trace + repro.sh) | — |
| `--failure-max <n>` | Cap the number of failure bundles per run | unlimited |
| `--trace-out <path>` | Write a JSONL trace of visits + actions | — |
| `--trace-replay <path>` | Replay a previously recorded trace | — |
| `--device <name>` | Emulate a Playwright device (e.g. `iPhone 14`) | — |
| `--network <profile>` | CDP throttling: `slow-3g` / `fast-3g` / `offline` | — |
| `--seed-from-sitemap <url\|path>` | Prepend URLs from sitemap.xml (index-aware) | — |
| `--shard <i/N>` | Run as shard i of N. See the `shard` subcommand to spawn + merge. | — |
| `--heatmap` | Print an action-frequency heatmap after the report | false |
| `--heatmap-top <n>` | Limit the heatmap to the top N rows | 20 |
| `--heatmap-out <path>` | Write the heatmap as JSON | — |
| `--junit <path>` | Write a Surefire-style JUnit XML for CI dashboards | — |
| `--baseline <path>` | Diff this run against a previous report | — |
| `--baseline-strict` | Fail on new clusters / newly failing pages vs baseline | false |
| `--github-annotations` | Emit GitHub Actions workflow commands for each cluster / dead link | false |
| `--compact` | Compact output | false |
| `--strict` | Fail on console errors + JS exceptions | false |
| `--quiet` | Minimal output | false |
| `--help` | Show help | — |

† `--ignore-analytics` suppresses matches for `googletagmanager`, `google-analytics`, `analytics.google`, `hotjar`, `clarity.ms`, `segment.io`, `amplitude`, `cloudflareinsights`, `facebook.net`, and generic `net::ERR_FAILED` from blocked resources. See `COMMON_IGNORE_PATTERNS` in `src/crawler.ts`.

Fault injection and invariants are programmatic-only — they can't be expressed in a shell command and are intentionally absent from the CLI.

## Action weighting

| Element type | Default weight |
| --- | --- |
| Navigation links (in `<nav>` / `<header>`) | 4.5 (3 × 1.5) |
| Regular links | 3.0 |
| Buttons | 2.0 |
| ARIA interactive roles | 2.0 |
| Input fields | 1.0 |
| Scroll | 0.5 |

Elements with visible text get a 1.5× multiplier.

```ts
new ChaosCrawler({
  baseUrl: "http://localhost:3000",
  actionWeights: { navigationLinks: 5, buttons: 3, inputs: 0.5, scroll: 0.1 },
});
```

## Error types

- `console` — `console.error(...)` calls
- `network` — failed requests
- `exception` — uncaught JS errors
- `unhandled-rejection` — unhandled promise rejections
- `invariant-violation` — a declared invariant failed
- `crash` — the page crashed

`PageResult.status` reports the navigation outcome (`success` / `error` / `timeout` / `recovered`), not whether the page was healthy. A page can be `success` with exceptions on it — check `PageResult.hasErrors` or `report.summary.pagesWithErrors` for the full picture.

## Report shape (abridged)

```json
{
  "baseUrl": "http://localhost:3000",
  "seed": 42,
  "reproCommand": "chaosbringer --url http://localhost:3000 --seed 42 --max-pages 20",
  "duration": 12345,
  "pagesVisited": 20,
  "totalErrors": 2,
  "blockedExternalNavigations": 5,
  "recoveryCount": 1,
  "pages": [
    {
      "url": "http://localhost:3000/",
      "status": "success",
      "statusCode": 200,
      "loadTime": 500,
      "errors": [],
      "hasErrors": false,
      "metrics": { "ttfb": 50, "fcp": 120 }
    }
  ],
  "summary": {
    "successPages": 20,
    "pagesWithErrors": 1,
    "consoleErrors": 1,
    "jsExceptions": 1,
    "unhandledRejections": 0,
    "invariantViolations": 0
  },
  "faultInjections": [{ "rule": "api-500", "matched": 4, "injected": 4 }]
}
```

## Troubleshooting

### `fault_rule_unmatched` warning at end of run

The logger emits one `fault_rule_unmatched` event per rule whose `matched` counter is `0` at the end of a crawl. Usually one of:

- The `urlPattern` regex has a typo (escape mismatches and missing `^` / `$` anchors are common).
- A broader catch-all earlier in the array is shadowing this rule — see [Rule order: first match wins](#rule-order-first-match-wins).
- The crawl never visited a page that issues the matching request (raise `maxPages` or check `excludePatterns`).

### `fault_rule_shadowed` warning at crawl start

Emitted (best-effort) when a later rule's `urlPattern` looks fully shadowed by an earlier one — typically a `/^https?:\/\//`-style catch-all placed before a specific override. Each warning includes `earlierRule`, `laterRule`, and a `sampleUrl` derived from the later pattern that the earlier rule also matches. Reorder so specific rules come first, or narrow the catch-all's pattern. False negatives are accepted (the detector is heuristic, not a regex-superset prover), but false positives are designed to be rare — `probability < 1` and non-overlapping `methods` filters disable the check for that pair.

### Loopback (`127.0.0.1`) sub-resources blocked under Chromium 130+

If the page you're testing loads sub-resources from `127.0.0.1` (or any loopback address) while the page itself is served from a non-loopback origin, Chromium's Private Network Access classifier may block the sub-resource with:

```
Permission was denied for this request to access the `loopback` address space.
```

Switching the page origin to `*.localhost` or to a `127.0.0.1:PORT` URL does not help when the response is intercepted (Playwright `page.route`), because Chromium doesn't classify the intercepted response as loopback. The reliable workaround is to launch Chromium with `--disable-web-security`:

```ts
await chaos({
  baseUrl,
  launchOptions: { args: ["--disable-web-security"] },
  // ...
});
```

This is a test-only flag — never ship it to real users. The PNA-specific flags (`--disable-features=BlockInsecurePrivateNetworkRequests,...`) are not sufficient on their own for intercepted responses.

## License

MIT
