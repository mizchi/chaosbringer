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
by default, not the crawler, not `chaosbringer scan`, not the CLI. Pass them
to `chaos()` / `ChaosCrawler`, or to `runScan({ crawler: { invariants } })`.
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
| `notBlank({ selector, minText, errorText })` | `data.not-blank` | the page shows fewer than `minText` (default 1) characters of visible text, or shows one of `errorText` (strings match as substrings, or RegExps) |

`invariants.dataSafety(options)` returns the first four, in that order. It
leaves `notBlank` out because a canvas or image-only page is blank by
design; add it when every page you crawl shows text.

Every preset takes `name`, `urlPattern` and `when` (default
`"afterActions"`). `dataSafety` takes `when`, `urlPattern` and `markers` for
all four, and one options object per preset (`xssMarker`, `injectedMarkup`,
`prototypePollution`, `renderedGarbage`) whose values win. The `data.`
prefix keeps `chaosbringer scan` reporting a failure as an
`invariant-violation` finding (an `a11y` prefix would make it an
accessibility one).

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
```

### What `renderedGarbage` leaves alone

The tokens match as whole words: `undefinedBehavior`, `isNaN` and `$NaN`
don't. Text inside `ignore` (default
`code,pre,kbd,samp,script,style,textarea,noscript`) isn't checked, so a code
sample that mentions `undefined` stays clean; `ignore: ""` checks
everything. Neither is text the user can't see: `hidden`, `display: none`,
`visibility: hidden`. `null` is not a default token because it is an
ordinary word in prose; add it with `tokens: [...yourTokens, "null"]`.

## Canaries

The security presets don't judge whether markup looks malicious. They look
for a canary that your payload carries, so a site that never received one
can't trip them.

- **A script ran**: the payload sets `window.__cb_xss_fired = 1`
  (`XSS_AUTH_MARKER`, what the auth-attack payloads set) or
  `window.__xss_fired = 1` (what `payloadDriver`'s `xss` set sets).
  `xssMarker` reads both; `markers` replaces them with your own.
- **Markup was parsed**: give an element in the payload the
  `data-cb-injected` attribute, `<b data-cb-injected>Admin</b>`. If an element
  with it is in the DOM, the page parsed data as HTML, even when nothing ran.
- **A script URL landed in a sink**: `javascript:window.__cb_xss_fired=1` as
  a website or link field. The crawler never clicks a `javascript:` link, so
  `injectedMarkup` flags the attribute, not its execution. The value is read
  the way the URL parser reads it (case, leading spaces and tabs inside the
  scheme don't hide it). `javascript:void(0)`, `mailto:` and `tel:` never
  count; `anyJavascriptUrl: true` counts every `javascript:` URL.
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
| `<details open ontoggle="window.__cb_xss_fired=1"></details>` | on the toggle event, queued as the element is inserted; it lands before the `afterActions` invariants |
| `<input autofocus onfocus="window.__cb_xss_fired=1">` | when the input takes focus |
| `<img src="data:,x" onerror="window.__cb_xss_fired=1">` | when the image fails to decode; a `data:` URL needs no request |
| `<script>…</script>`, `<svg onload=…>` | never, through `innerHTML` |

`<img src=x onerror=…>` runs too, but the request for `x` fails, and the
browser logs that 404 as a console error, which fails `strict` on a page
that escapes the payload correctly as well. Use a `data:` URL instead.

Most of `payloadDriver`'s built-in `xss` set is `<script>` and
`<svg/onload>`, which run only when the server renders the value into the
HTML, and `src=x`, whose 404 fails `strict`. Against a client-rendered page,
pass your own list.

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
  tree, which doesn't descend into shadow roots.
- **Values that are well-formed but wrong**: an off-by-one total, the wrong
  currency.
- **Server-side classes** (SQL injection, SSRF, path traversal): only the
  page's reaction to what the server sends back.
- **`chaosbringer scan` cannot deliver bad data itself**: its chaos crawls
  inject only 500s, network errors and hangs, and it takes no
  `faultInjection`. Give it the presets with `crawler.invariants`, and the
  data through what it does take (a `baseUrl` query, `crawler.lifecycleFaults`,
  `crawler.driver`).
