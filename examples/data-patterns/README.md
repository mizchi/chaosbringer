# Data patterns: apps that mishandle bad and hostile data

A catalog of tiny apps, each with a known way of mishandling data it didn't
expect (the **buggy** variant) and its idiomatic fix (the **fixed**
variant). It is the correctness and security counterpart of
[perf-patterns](../perf-patterns): the catalog doubles as a benchmark of
what chaosbringer can find.

The app's own server is healthy and serves good data. chaosbringer delivers
the bad data on the way in, and every crawl runs with `strict: true` and the
same invariant suite (`invariants.dataSafety()` plus `invariants.notBlank()`,
see [the data-safety recipe](../../docs/recipes/data-safety.md)). Each entry is
proven by three crawls:

1. **buggy + bad data**: the expected signal is reported (an error whose
   message matches, a failed invariant, or a blocked off-site navigation),
   and nothing else that the entry didn't declare;
2. **buggy + benign data**, through the same channel: clean. This is the
   control: the signal is caused by the data, not by the page;
3. **fixed + bad data**: clean, strict exit 0.

and three checks that keep the proof honest:

- **the data arrived** in every run, by the channel's own evidence (the
  fault rule's injection count, the storage fault's firings, the query in
  the visited URL, a form fill that succeeded);
- **every check ran**: each suite invariant is wrapped in a counter, and a
  clean run in which one never ran fails (a check that never runs can't
  fail);
- **each verdict can fail here**: "clean" fails on the buggy + bad run, and
  "flagged" fails on both other runs, so no verdict passes vacuously.

Oracle entries have no bug: they are pages full of near misses (tokens in
code samples, `javascript:void(0)` links, an own key named `cbPolluted`)
that the suite must stay quiet on. They are crawled once and must be clean.

## How the data gets in

| Channel | Delivered by | Proof it arrived |
|---|---|---|
| `response` | `faults.status(200, { body })` on the path's fetch/XHR, anchored so `/api/user` doesn't also match `/api/users`. The body is written byte for byte, so truncated JSON and an own `__proto__` key arrive intact | `faultInjections["data:<path>"].injected` ≥ 1 |
| `query` | appended to the entry URL; the crawler keeps the query (it drops only the fragment) | the visited page's URL carries it |
| `storage` | `faults.tamperStorage({ when: "afterLoad" })`; the page reads the value on a click | `lifecycleFaults["data:<key>"].fired` ≥ 1 |
| `form` | `payloadDriver({ payloads: [value] })`: a one-value list, so the fill is deterministic | an `input` action that succeeded |

Payloads only set markers: `window.__cb_xss_fired = 1`, a `data-cb-injected`
attribute, a `cbPolluted` key on `Object.prototype`, a redirect to the
catalog's own `localhost` marker page. No `alert()`, no request to another
host.

## Run it

```bash
pnpm install                       # builds chaosbringer's dist via `prepare`

pnpm test                          # every entry, three crawls each, as assertions
PATTERN=null-relation pnpm test    # one entry (comma-separate several)
PATTERN_SHARD=2/3 pnpm test        # the 2nd of 3 round-robin shards
pnpm report                        # crawl all and rewrite the table below
pnpm scan-check                    # what `chaosbringer scan` finds, below that
pnpm typecheck
```

## Results

Each row: what the buggy variant reports on bad data, its exit code with
and without `strict`, and whether the control and the fix are clean. A bold
cell is a verdict that failed, with its first problem.

<!-- results:start -->
Measured by `pnpm report` on 2026-10-27: one crawl per case, `strict` on, the catalog suite. "exit" is the buggy + bad run's exit code with `strict` / without it.

| entry | category | data via | buggy + bad data: reported | exit | buggy + benign data | fixed + bad data | fix |
|---|---|---|---|---|---|---|---|
| [null-relation](src/patterns/null-relation.ts) | bug-data | response `/api/user` | `unhandled-rejection "Cannot read properties of null (reading 'name')"` | 1 / 0 | clean | clean | Model the relation as nullable where it is read (a null check, optional chaining with a fallback, or a type that says User \| null) and render the empty state. |
<!-- results:end -->

## What `chaosbringer scan` finds

The table above is the catalog's own test: it hands chaosbringer the bad
data and knows what to look for. [`chaosbringer
scan`](../../docs/recipes/scan.md) takes no fault rules, and runs no
data-safety check unless told to. `pnpm scan-check` serves each entry's bad
data through what scan can reach (a response entry's route answers with the
bad body itself; a query rides on the URL; storage and form data go in as
`crawler.lifecycleFaults` and `crawler.driver`), and scans every variant
twice: as it comes, and with the catalog suite as `crawler.invariants`.

A variant is flagged when a `bug` finding matches the entry's signal: an
error by a `js-exception` or `unhandled-rejection` finding whose title
matches the message, an invariant by an `invariant-violation` finding that
names it. Expect the entries that throw to be flagged out of the box, and
the ones caught only by an invariant (a marker, a polluted prototype,
garbage on screen, a blank page) only with the suite. The script exits 1
when a fixed variant is still flagged or an oracle entry has any bug
finding.

<!-- scan-check:start -->
Measured by `pnpm scan-check` on 2026-10-27: `runScan` with `chaos: false`, one page, the entry's seed and actions, on the bad data.

**1 of 1** buggy variants are flagged out of the box, **1 of 1** with the catalog suite as `crawler.invariants`; **0** fixed variants are still flagged.

| entry | data via | buggy: out of the box | buggy: with `invariants.dataSafety()` + `notBlank()` | fixed: still flagged | every bug rule on buggy |
|---|---|---|---|---|---|
| [null-relation](src/patterns/null-relation.ts) | response `/api/user` | `unhandled-rejection` | `unhandled-rejection` | – | `unhandled-rejection` |
<!-- scan-check:end -->

## What this can't see

- **Dialog-only payloads** (`alert`, `confirm`, `prompt`): nothing listens
  for a dialog, and Playwright dismisses it. A payload has to set a marker.
- **A `javascript:` link running**: the crawler never clicks one.
  `injectedMarkup` flags the URL in the sink, not its execution.
- **Payloads in the URL fragment**: the crawler drops the hash before it
  navigates, so DOM XSS through `location.hash` is out of reach.
- **Open redirects in exit codes or scan**: a blocked off-site navigation is
  recorded only in `pages[].blockedNavigations` (and `redirectedTo`). It
  fails no exit code and raises no scan finding, and the redirected page's
  errors are dropped. Entries with this signal are judged on the report
  field alone.
- **Markup that doesn't run and carries no canary**: an inserted `<script>`
  (which `innerHTML` never runs), attacker HTML without `data-cb-injected`.
- **Well-formed but wrong values**: an off-by-one total, the wrong currency.
- **Server-side classes** (SQL injection, SSRF, path traversal, IDOR): only
  the page's reaction to what the server sends back is visible.
- **Renderer crashes**: the `crash` page-error type exists but is never
  emitted.
- **`chaosbringer scan` delivering bad data itself**: it takes no
  `faultInjection`, and its chaos crawls inject only 500s, network errors and
  hangs.

## Layout

| File | What it is |
|---|---|
| `src/pattern.ts` | the `DataPattern` type (injection channels, signals) and the route helpers (`html`, `json`, `raw`, `handler`, `page`) |
| `src/patterns/<id>.ts` | one entry each; discovered automatically |
| `src/server.ts` | serves one variant on an ephemeral port, plus a `localhost` server for `thirdPartyRoutes` |
| `src/registry.ts` | `loadPatterns()`: reads `src/patterns/*.ts`, imports and checks each one |
| `src/suite.ts` | the invariant suite every crawl runs, and the counter that proves each check ran |
| `src/inject.ts` | each channel as crawl options (`toCrawlOptions`), and as served routes for scan (`toServedRoutes`) |
| `src/detect.ts` | `runCase()`: one crawl of one variant with one kind of data |
| `src/verdict.ts` | `judgeBuggy`, `judgeClean`, `judgeDelivered`: pure, unit-tested on synthetic reports |
| `data-patterns.e2e.test.ts` | the assertions, per entry |
| `scripts/report.ts` | fills the results table |
| `scripts/scan-check.ts` | runs `chaosbringer scan` on every variant and fills the scan section |

## Adding an entry

1. Copy `src/patterns/null-relation.ts` to `src/patterns/<your-id>.ts`; `id`
   must equal the file name.
2. Write `routes(variant)`: the same paths and the same good data for both
   variants, differing only in the page script. API routes are `json()`, or
   `raw()` for bytes `json()` can't write.
3. Set `inject`: the channel, the `bad` data and the `benign` data the
   control run sends the same way.
4. Set `expect.signal`, and in `alsoSignals` anything else the buggy run
   reports: the run's signals must be exactly those.
5. Set `crawl` only if the page needs it: `maxActionsPerPage` and
   `actionWeights: { scroll: 0 }` when a click reads the data, `entry` for
   another start page.
6. Run `PATTERN=<your-id> pnpm test` twice, then
   `PATTERN=<your-id> pnpm report`.

No registration step: the registry imports every `.ts` file in
`src/patterns/` (files starting with `_` are skipped). An `oracle` entry
takes `inject: { channel: "none" }` and `expect: { signal: "none" }`, and only
an oracle entry may.

### Rules for every entry

- **Every page has a static `<h1>`**, so `notBlank` stays quiet unless the
  page really is blank.
- **The fixed variant shows a fallback or an error message**, not an empty
  element.
- **No `console.error` calls, no 4xx/5xx**: either is a console error, which
  fails `strict` on the fixed variant too.
- **No CSP-based fixes**: a blocked inline handler logs "Refused to execute
  inline event handler", a console error.
- **Match errors by message, never by cluster type alone.** Whether a throw
  in a promise chain is reported as an exception or an unhandled rejection
  depends on how it escaped; a regex on the message is stable.
- **Payloads that run through `innerHTML`**: `<details open ontoggle>`,
  `<input autofocus onfocus>` or `<img src="data:…" onerror>`. `<svg onload>`
  and an inserted `<script>` never run; `<img src=x>` adds a 404.
- **Nothing on a timer**: invariants run after load and after the actions,
  and a payload that runs later isn't seen.
