# Scanning a site you don't know: `chaosbringer scan`

You have a URL and no test suite, no list of the site's API, and no idea
where it is slow. `chaosbringer scan` sweeps it in one command. It crawls
the site, breaks the site's own API calls, and turns what it measured into
a ranked list of findings. Each finding says where it was seen, what was
measured, and what usually causes it.

```bash
chaosbringer scan --url https://staging.example.com --max-pages 30 \
  --exclude "/logout" --exclude "/account/delete" --ignore-analytics
# → chaosbringer-scan/scan-report.md   (read this)
#   chaosbringer-scan/scan-report.json (the same, for tools)
```

> Only scan sites you own or may test. The crawler clicks, types and submits
> forms, and the chaos crawls send each API request just as the page would.
> Keep destructive URLs out with `--exclude`, and point it at staging rather
> than production.

## What it runs

1. **Clean crawl.** A seeded crawl with per-step perf measurement on (every
   page load and every action is a lightbringer span), plus JS/CSS
   coverage. From this crawl come the **bugs**: pages that fail or answer
   4xx/5xx, uncaught exceptions, unhandled rejections and console errors.
   The **slow spots** come from it too: Web Vitals, main-thread blocking,
   slow interactions, forced layouts, style recalculation, DOM size,
   request fan-out, waterfalls, heavy pages, images and compression, memory
   that climbs, and unused JS. It settles adaptively, so a page that never
   goes quiet (polling, a rAF loop) is counted rather than timing out.
2. **Endpoint discovery.** Every same-site `fetch` / XHR request the clean
   crawl saw is folded into an endpoint (`/api/items/42` →
   `/api/items/:id`). Third-party requests are left out: whether a
   failing analytics tag breaks the page is a different question.
3. **Chaos crawls**, one per fault, with the same seed so they take the same
   paths. In each one, **every** request to those endpoints fails in a
   single way:
   - `500`: HTTP 500 with a JSON error body,
   - `abort`: a network-level failure,
   - `hang`: no response, then failed after `--hang-ms` (default 8000).

   It fails every request, not a random share, because a small site may
   call an endpoint once per crawl. A 15% roll would usually miss it and
   report that nothing was found.
4. **Analysis.** A pure function (`analyzeScan`) compares the reports and
   ranks the findings: high, then medium, then low.

The chaos crawls produce the **resilience** findings: what goes wrong only
when an API call fails.

| rule | what it means |
|---|---|
| `fault-new-error` | An exception, rejection or console error that never happened in the clean crawl. The browser's own "Failed to load resource" line for the injected fault is not counted. The code assumes the request succeeds. |
| `fault-page-broken` | A page that loaded clean and fails or times out when its API call fails. |
| `no-request-timeout` | A step that was still waiting when the hung request was finally failed, while the same step was fast in the clean crawl. The request has no client deadline. |

## Reading the report

`scan-report.md` opens with a table. Each finding also gets its own
section, for example:

```
### 🔴 Steps that block the main thread
`span-blocking` · perf · high · seen 3×
- /search :: click button:has-text("Filter"): 412ms blocking over 3 long task(s), longest 260ms
- / :: load: 180ms blocking over 2 long task(s), longest 121ms
…
Catalog patterns with this signal: long-task-click, eager-heavy-bundle, no-yield-before-work, …
```

- **`where`** is a page URL, or, for a step, its perfKey
  (`<urlPattern> :: <kind>`, see [perf.md](perf.md#perfkey-the-key-that-survives-a-rerun)).
  The key is stable across runs, so you can re-measure the same step.
- **Catalog patterns** link to entries of the
  [perf-patterns catalog](../../examples/perf-patterns/README.md). Each
  entry is a tiny page with the anti-pattern, its fix, and the same
  signal. They are candidate causes, not a diagnosis: open the one whose
  description fits what the page does.
- **Thresholds** live in `SCAN_THRESHOLDS`. For vitals they are Web Vitals'
  own good and poor bounds. Elsewhere they are rules of thumb: 50 ms of
  blocking in one step, 30 layouts, 1500 DOM nodes, and so on. The report
  measures one crawl on this machine. Re-run with the printed `--seed` to
  see which findings are stable.

## Going further from a finding

- **See why a step is slow.** Re-run the clean crawl's `reproCommand` with
  `--perf-trace`, then run `chaosbringer perf drilldown <report> "<perfKey>"`.
- **Turn a resilience finding into a test.** Write the fault the scan used
  as a `faults.status(500, { urlPattern })` rule with an invariant that
  checks the error state, as described in the
  [skill](../../.claude/skills/chaosbringer/SKILL.md). Or use a
  deterministic `schedule` to fail the first call and let the retry
  through.
- **Guard against regressions.** Scan before and after a change, then run
  `chaosbringer perf regress <before>/clean-report.json --current <after>/clean-report.json`.
- **Gate CI.** `--fail-on high` exits 1 when a high finding exists.

## Options

| flag | default | |
|---|---|---|
| `--max-pages` / `--max-actions` | 20 / 5 | per crawl |
| `--faults` | `500,abort,hang` | which chaos crawls to run |
| `--no-chaos` | | the clean crawl only |
| `--hang-ms` | 8000 | how long a hung request is held |
| `--seed` | random | printed, so the run can be repeated |
| `--axe` | off | axe-core on every page (needs `axe-core`) |
| `--no-coverage` | | skip coverage (and the unused-JS finding) |
| `--storage-state` | | a Playwright storageState, for a logged-in scan |
| `--sitemap` | | also start from the URLs of a sitemap.xml |
| `--network slow-3g\|fast-3g` / `--device "<name>"` | | throttle / emulate; a site on localhost is too fast to cross the Web Vitals bounds otherwise |
| `--exclude`, `--ignore-error`, `--ignore-analytics`, `--ignore-preset` | | as for the crawl |
| `--fail-on high\|medium\|low` | | exit 1 at or above that severity |

Programmatically, `runScan(options)` returns
`{ analysis, baseline, chaos, endpoints, files }`, and `analyzeScan(clean,
chaosRuns)` runs only the analysis on reports you already have:

```ts
import { runScan } from "chaosbringer";

const { analysis } = await runScan({ url: "http://localhost:3000", maxPages: 10 });
const high = analysis.findings.filter((f) => f.severity === "high");
```

## How well it finds known problems

The catalog doubles as a benchmark. `pnpm scan-check` in
`examples/perf-patterns` scans each pattern's slow and fixed variants. It
records whether the slow one is flagged with its own pattern, and whether
the fix makes that finding go away. The latest result is in that
[README](../../examples/perf-patterns/README.md#what-chaosbringer-scan-finds-without-being-told).

## Scanning from behind a proxy

Some failures come from the machine running the scan, not from the site.
The report leaves them out of the findings and lists them once, under
"Not counted":

- `net::ERR_TUNNEL_CONNECTION_FAILED` / `ERR_PROXY_CONNECTION_FAILED`: a
  corporate or sandbox proxy refused the host (often analytics and ad
  domains).
- `net::ERR_BLOCKED_BY_CLIENT`: the crawler's own external-navigation
  guard, which also stops cross-origin iframe documents such as video
  embeds.
- `net::ERR_ABORTED`: a request cancelled in flight, mostly beacons and
  prefetches cut off when the crawl navigated on.
- `net::ERR_CERT_AUTHORITY_INVALID`: the scanning browser does not trust the
  issuer of a subresource's certificate, usually a proxy's. A page whose own
  certificate is bad still fails to load, and that is still reported.
- "no supported source" media errors: Playwright's Chromium ships without
  the H.264 / AAC codecs that Chrome has.

An exception such as "Failed to fetch" on a page where one of these broke a
request stays in the findings, but its evidence says it may be the knock-on
effect. Paths a CDN or host injects (`/cdn-cgi/`, `/_vercel/`,
`/.well-known/`) are not treated as the site's API.

If every page fails with `net::ERR_CERT_AUTHORITY_INVALID`, the proxy
intercepts TLS and Chromium does not trust its CA. Playwright's Chromium
reads the NSS store in `~/.pki/nssdb`, so add the proxy's CA there
(`certutil` is in `libnss3-tools`):

```bash
certutil -A -d sql:$HOME/.pki/nssdb -n corp-proxy -t "C,," -i /path/to/proxy-ca.crt
```

Do not use `--ignore-certificate-errors` or a SPKI allow-list for the
proxy's key instead. Chromium applies either one to every connection that
goes through the proxy, so it stops verifying the real sites' certificates
as well.

If the crawl barely reached the site (one page with no links, or a nearly
empty start page), the report opens with a warning instead of reading as a
clean site. That happens with a bot check, a rate limit, a consent wall, or a
site that needs `--storage-state`. The crawler's own navigation errors
(`page.goto: Timeout …`) are not reported as the site's exceptions; the page
that failed to load is. A page that fails in a chaos crawl counts against the
fault only if the fault hit that page's load.

A same-site URL that redirects to another origin (a `/chat` that 302s to a
Discord invite) is recorded with the page's `redirectedTo` and counted as a
blocked external navigation; nothing of the other site is crawled or
reported.

## What it does not see

- Bugs that show no error: wrong totals, a button that does nothing.
  These need an oracle, meaning an invariant or a model; see the skill.
- Worker traffic, and the in-page metrics of cross-origin iframes (only
  their network is measured).
- Pages the random crawl does not reach: forms that need valid input, or
  flows behind a login without `--storage-state`. Raise `--max-pages`, or
  start from the site's sitemap with `--sitemap`.
