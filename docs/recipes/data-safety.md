# Bad and hostile data: data-safety invariants

Most fault rules break a response: a 500, a dropped connection, a request
that never answers. A response can also succeed and carry data the page
doesn't expect: a relation that is `null`, a price sent as `"12,5"`, a
comment body with markup in it. Whether the page survives that is a
question about what the data did once it arrived, and these invariant
presets answer it.

```ts
import { chaos, invariants } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000",
  strict: true,
  invariants: [...invariants.dataSafety(), invariants.notBlank()],
});
```

They are ordinary invariants, like `invariants.axe()`: nothing turns them on
by default. Pass them to `chaos()` / `ChaosCrawler`, or to
`runScan({ crawler: { invariants } })`; from the command line, name them
with `--invariants` (or `--data-safety`, for `--invariants data-safety`) on
the crawl, `shard` and `scan`:

```bash
chaosbringer --url http://localhost:3000 --strict --data-safety
chaosbringer --url http://localhost:3000 --invariants data-safety,not-blank
chaosbringer scan --url http://localhost:3000 --data-safety --fail-on high
```

The names are `data-safety` (the five `dataSafety()` returns, not
`not-blank`), `xss-marker`, `injected-markup`, `prototype-pollution`,
`rendered-garbage`, `no-offsite-redirect`, `not-blank`, and `axe` for `--axe`. A list is
comma-separated, the flag repeatable, and a check named twice (or a member
named beside `data-safety`) runs once; an unknown name is refused with exit
2 before the browser starts. The flags build each preset with its defaults:
`markers`, `tokens`, `ignore`, `selector`, `urlPattern` and `when` have no
flag, so a run that needs them uses the library. The one that has a flag is
`noOffsiteRedirect`'s `allow`: `--offsite-redirect-allow
https://login.example.com` (comma-separated, repeatable, origins only;
refused without the check). The `Repro:` line carries the flags back as one
`--invariants` list and one `--offsite-redirect-allow` list.

A failure is a page error of type `invariant-violation`, which always fails
the run's exit code.

A bad value that makes the page throw needs no preset at all: the
`TypeError` is an exception or an unhandled rejection, and `strict: true`
(`--strict`) fails the run on it. The presets are for the damage that
doesn't throw.

## The presets

| Preset | Name | Fails when |
|---|---|---|
| `xssMarker({ markers })` | `data.xss-marker` | a marker is truthy on `window`: a payload ran |
| `injectedMarkup({ markers, attribute, anyJavascriptUrl })` | `data.injected-markup` | an element carries `attribute` (default `data-cb-injected`), or an `href` / `src` / `action` / `formaction` / `xlink:href` holds a `javascript:` URL that names a marker |
| `prototypePollution()` | `data.prototype-pollution` | `Object.prototype` has an enumerable key |
| `renderedGarbage({ tokens, ignore, selector })` | `data.rendered-garbage` | visible text shows `undefined`, `NaN`, `[object Object]` or `Invalid Date` as a word |
| `noOffsiteRedirect({ allow })` | `navigation.no-offsite-redirect` | the page sent the browser to another origin on its own (a script, a meta refresh, a 3xx, a click that followed the page's own `?next=`; not a click to a URL the page wrote, not an iframe) that `allow` does not list. `open redirect: …` when the target was in the page's own URL |
| `notBlank({ selector, minText, errorText })` | `data.not-blank` | the page shows fewer than `minText` (default 1) characters of visible text, or shows one of `errorText` (strings match as substrings, or RegExps) |

`invariants.dataSafety(options)` returns the first five, in that order. It
leaves `notBlank` out because a canvas or image-only page is blank by
design; add it when every page you crawl shows text.

Every preset takes `name`, `urlPattern` and `when` (default
`"afterActions"`), but `noOffsiteRedirect`, which always runs `afterVisit`
and takes `allow` instead of `when`. `dataSafety` takes `when` for the first
four and `urlPattern` for all five,
and `markers` for `xssMarker` and `injectedMarkup` (the two that read a
canary); `prototypePollution` and `renderedGarbage` don't take `markers`. It
also takes one options object per preset (`xssMarker`, `injectedMarkup`,
`prototypePollution`, `renderedGarbage`, `noOffsiteRedirect`) whose values
win: `dataSafety({ noOffsiteRedirect: { allow: ["https://login.example.com"] } })`. The `data.`
prefix keeps `chaosbringer scan` reporting a failure as an
`invariant-violation` finding (an `a11y` prefix would make it an
accessibility one): `high` for `data.xss-marker`, `data.injected-markup` and
`data.prototype-pollution`, `medium` for the others, so `--fail-on high`
stops on hostile data that ran or reached the DOM. `noOffsiteRedirect` is
reported as scan's own `open-redirect` finding instead (`security`, `high`
when the target was in the URL, `low` when not), which scan raises with or
without the check. One that shows only in a chaos crawl (a page that renders `undefined` once its API answers 500) is a
`fault-new-error` resilience finding.

> **Behaviour change:** these used to be `medium` `invariant-violation`
> findings for every preset, and one seen only in a chaos crawl was dropped.
> A `runScan({ crawler: { invariants: dataSafety() } })` gate on `high` or
> `medium` that passed can now fail (see [scan](scan.md#data-safety-checks)).

Each preset checks the top document and every iframe, same-origin or not.
An iframe that can't be read (detached mid-check, stuck for 5 s) is skipped,
and so is the browser's error page left in an iframe whose cross-origin
navigation the crawl blocked. The message names the iframe a finding is in
and lists up to three samples per frame:

```
[data.xss-marker] XSS marker set: window.__cb_xss_fired
[data.injected-markup] injected markup: <b data-cb-injected>, <a href="javascript:window.__cb_xss_fired=1">
[data.prototype-pollution] Object.prototype polluted: cbPolluted
[data.rendered-garbage] rendered garbage: NaN in "Total: NaN", undefined in "Hello undefined" (+1 more)
[data.not-blank] blank page: 0 characters of visible text in body, fewer than 1
[data.xss-marker] XSS marker set: in frame http://localhost:3001/embed: window.__xss_fired
[navigation.no-offsite-redirect] open redirect: http://localhost:3000/go?next=https%3A%2F%2Fevil.invalid%2F -> https://evil.invalid/ (script redirect, to the URL in its "next" query parameter)
```

### What `noOffsiteRedirect` counts

The crawl blocks a navigation to another origin before it leaves the
browser, and follows a redirect hop (so the other host does receive a
302's request), then stops there. Each is recorded in
`pages[].offsiteNavigations` with its `trigger`: a `script`, a
`meta-refresh` and a `server-redirect` are the page leaving on its own,
which the check fails; a `click` (a crawler step went to a URL the page
wrote: a link, a form, a share button's fixed `location`; the user asked to
go) and a `frame` (an iframe) are not. A link straight to another origin
is never clicked. A step is not a pass on its own: a "Continue" button
whose handler follows the page's own `?next=` is a `script`, and a form
posted to an endpoint of the site's that answers a 3xx off-site is a
`server-redirect` named by that endpoint's URL. `reflected` says the target
was in the page's own query (`{ in: "query", param: "next" }`) or fragment,
as written or URL-decoded: the open redirect, which the message calls by
name. A 302 to a host that is down is the same redirect, with `failed` set,
not a failed load of the page. A redirect that fires again (a delayed one,
each time the crawler goes back) is listed once. A page that goes to
`about:blank` left for no other site and is not counted.

Only the crawler records off-site navigations. `scenarioLoad` runs every
invariant after every step and records none, so there the check always
passes.

`allow` takes origins (`"https://login.example.com"`, no path) and RegExps
tested on the target URL, for the redirects a site means: an SSO provider, a
payment page. A crawl only sees the redirects its URLs carry: a `?next=`
the site never links to with an off-site value is not probed (send one on
the start URL, as above). See the README's [off-site
redirects](../../packages/chaosbringer/README.md#off-site-redirects-and-open-redirects)
for the report fields and output lines.

> **Behaviour change:** `dataSafety()` and `--data-safety` used to have
> four checks. With `noOffsiteRedirect` in them, a run that passed can fail
> on a page that redirects off-site; pass `allow` (or
> `--offsite-redirect-allow`) for the origins it may go to.

### What `renderedGarbage` leaves alone

A token is bounded by a word character only on the side it begins or ends
with one, so `undefinedBehavior` and `isNaN` don't match — but `$NaN` (a
price) and `Hello[object Object]` do: visible text is prose, where `$` reads
as a currency symbol and brackets as punctuation, not as word edges. Text
inside `ignore` (default
`code,pre,kbd,samp,script,style,textarea,noscript,[contenteditable]`) isn't
checked, so a code sample or an in-page editor that shows `undefined` stays
clean; `ignore: ""` checks everything. Neither is text the user can't see:
`hidden`, `display: none`, `visibility: hidden`. Text the user *can* see is
checked even when its own element has no box of its own — the option a
`<select>` shows, and a `display: contents` wrapper. Prose and
API-reference text are **not** scoped out: a page that writes *about*
`undefined`, or shows a `find(key): Item | undefined` signature, fails unless
you scope it out with `selector`, `urlPattern` or `ignore`. `null` is not a
default token because it is an ordinary word in prose; add it with
`tokens: [...yourTokens, "null"]`.

## Canaries

`xssMarker` and `injectedMarkup` don't judge whether markup looks malicious.
They look for a canary that your payload carries, so a site that never
received one can't trip them. (`prototypePollution` and `renderedGarbage` are
not canary-scoped: any enumerable `Object.prototype` key, or any garbage token
in visible text, trips them, whatever put it there.)

- **A script ran**: the payload sets `window.__cb_xss_fired = 1`
  (`XSS_AUTH_MARKER`, what the auth-attack payloads set) or
  `window.__xss_fired = 1` (what `payloadDriver`'s `xss` set sets).
  `xssMarker` reads both; `markers` replaces them with your own. It counts a
  marker only when it is an *own* property of `window`, so an element whose
  `id` is a marker name (DOM clobbering) doesn't trip it.
- **Markup was parsed**: give an element in the payload the
  `data-cb-injected` attribute, `<b data-cb-injected>Admin</b>`. If an element
  with it is in the DOM, the page parsed data as HTML, even when nothing ran.
- **An event handler was injected**: an `on*` attribute whose value names a
  marker, `<img ... onerror="window.__cb_xss_fired=1">`. The crawler never
  hovers or fires it, so `injectedMarkup` flags the attribute as a sink, fired
  or not.
- **A script URL landed in a sink**: `javascript:window.__cb_xss_fired=1` as
  a website or link field. The crawler never clicks a `javascript:` link, so
  `injectedMarkup` flags the attribute, not its execution. The value is read
  at least as loosely as the URL parser reads it — case, and spaces, tabs or
  newlines inside the scheme, don't hide it; it strips those C0 and space
  characters everywhere, not only at the ends, so it errs towards flagging.
  `javascript:void(0)`, `mailto:` and `tel:` never count; `anyJavascriptUrl:
  true` counts every `javascript:` URL.
- **The prototype was polluted**: a `__proto__` key, e.g.
  `{"__proto__":{"cbPolluted":"1"}}`. Any enumerable key on
  `Object.prototype` fails; the name only makes the message readable. An
  object's own `cbPolluted` key, or a `__proto__` key `JSON.parse` kept as an
  own key, does not.

Payloads should only set markers: no `alert()`, no requests to other hosts.
A dialog isn't detected at all (Playwright dismisses it and nothing
listens), so a marker is also the only payload that reports itself.

## Payloads that run through `innerHTML`

`innerHTML` never runs a `<script>` it inserts, and an inserted
`<svg onload>` never fires, so the classic payloads prove nothing against a
page that renders data on the client. These do run, and log nothing:

| Payload | Runs |
|---|---|
| `<details open ontoggle="window.__cb_xss_fired=1"></details>` | on the toggle event, queued as the element is inserted; it lands before the `afterActions` invariants. The most reliable form |
| `<input autofocus onfocus="window.__cb_xss_fired=1">` | when the input takes focus — but `autofocus` is honored only while nothing else has focus, so on a page that already focuses a field (a search or login box) it never fires |
| `<img src="data:,x" onerror="window.__cb_xss_fired=1">` | when the image fails to decode; a `data:` URL needs no request |
| `<script>…</script>`, `<svg onload=…>` | never, through `innerHTML` |

Prefer the `<details open ontoggle>` form: it doesn't depend on focus state.
`<img src=x onerror=…>` runs too, but the request for `x` fails, and the
browser logs that 404 as a console error, which fails `strict` on a page
that escapes the payload correctly as well. Use a `data:` URL instead.

Most of `payloadDriver`'s built-in `xss` set is `<script>` and
`<svg/onload>`, which run only when the server renders the value into the
HTML, and `src=x`, whose 404 fails `strict`. Its
`<iframe src="javascript:window.__xss_fired=1">` entry is the exception: it
runs through `innerHTML`, caught by `xssMarker` (in the iframe) and
`injectedMarkup`. Against a client-rendered page, pass your own list.

## Delivering the data

The presets check the page; the data comes from somewhere else. The page's
own server stays healthy and serves good data, and chaosbringer swaps in the
bad data on the way.

**An API response**: `faults.status(200, { body })` answers a request with
your bytes instead of the server's. The body is written as is, so a
truncated JSON document or an own `__proto__` key reaches the page intact (a
JavaScript object literal would have dropped the key).

```ts
import { chaos, faults, invariants } from "chaosbringer";

const { report } = await chaos({
  baseUrl: "http://localhost:3000/post/1",
  strict: true,
  faultInjection: [
    faults.status(200, {
      urlPattern: /\/api\/comments(?:\?|$)/,
      resourceTypes: ["fetch", "xhr"],
      contentType: "application/json",
      body: JSON.stringify([{ body: '<details open ontoggle="window.__cb_xss_fired=1"></details>' }]),
      name: "data:/api/comments",
    }),
  ],
  invariants: invariants.dataSafety(),
});
const delivered = report.faultInjections?.find((s) => s.rule === "data:/api/comments")?.injected ?? 0;
```

Anchor the `urlPattern` (`/api/comments` should not also match
`/api/comments-count`), and check that the rule was injected: a rule that
never matched leaves a clean run that proves nothing.

**A form**: `payloadDriver` fills forms with the payloads you list.

```ts
import { chaos, invariants, payloadDriver } from "chaosbringer";

await chaos({
  baseUrl: "http://localhost:3000/guestbook",
  driver: payloadDriver({
    payloads: ['<b data-cb-injected>hi</b>', '<details open ontoggle="window.__cb_xss_fired=1"></details>'],
  }),
  invariants: invariants.dataSafety(),
});
```

**A query string**: put it in `baseUrl`, e.g.
`` `http://localhost:3000/search?q=${encodeURIComponent(payload)}` ``. The
crawler keeps the query, but drops the fragment, so a payload that only
`location.hash` carries never reaches the page.

**Storage**: `faults.tamperStorage({ scope: "localStorage", key: "prefs", value: "{bad" })`
writes the value after the page loads, so it reaches code that reads it
later, on a click for instance.

## When the checks run

Invariants run at two points per page: after it loads (`when: "afterLoad"`)
and after the crawler's actions (`"afterActions"`, the default). A payload
that runs later, on a timer or after the last action, isn't seen.

## What these don't see

- **Execution of a `javascript:` URL**: only that it landed in a sink.
- **Markup without a canary**: an inserted `<script>` that never ran,
  attacker HTML without `data-cb-injected`.
- **Shadow DOM**: `injectedMarkup` and `renderedGarbage` read the document
  tree and don't descend into shadow roots, so a canary or garbage token
  inside a web component's shadow DOM is missed. `notBlank` does read the text
  of *open* shadow roots, so a web-component page (Lit, Stencil, Shoelace)
  isn't a false "blank page"; a *closed* shadow root can't be read and is
  still missed.
- **Values that are well-formed but wrong**: an off-by-one total, the wrong
  currency.
- **Server-side classes** (SQL injection, SSRF, path traversal): only the
  page's reaction to what the server sends back.
- **`chaosbringer scan` cannot deliver bad data itself**: its chaos crawls
  inject only 500s, network errors and hangs, and it takes no
  `faultInjection`. Give it the presets with `--invariants` (or
  `crawler.invariants`), and the data through what it does take: a query on
  `--url` from the shell, and from code also `crawler.lifecycleFaults` and
  `crawler.driver`.
