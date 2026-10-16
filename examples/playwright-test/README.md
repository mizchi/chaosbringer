# Example — chaosbringer inside Playwright Test

When you already have a Playwright Test suite and you want chaos coverage as one tool among many (rather than a separate `chaos/run.ts` driver), use `chaosbringer/fixture`.

## What this example shows

- Tiny static site (`/`, `/about`, `/broken-link`, plus `/stock` and the `/api/stock` it reads) served by `node:http` — a stand-in for "your app".
- Two integration patterns in one `tests/chaos.spec.ts`:
  1. **`chaosTest`** — the chaos fixture directly. Best when chaos *is* what the file is about.
  2. **`withChaos()` extension** — extend `base` so a regular Playwright Test grows a `chaos` fixture without becoming a chaos-only file.
- Three useful assertions: `chaos.expectNoErrors(result)`, `chaos.expectNoDeadLinks(report)`, and ordinary `expect(...)` from `@playwright/test`.
- One fault: `faults.status(503, …)` in `chaosOptions.faultInjection` takes `/api/stock` down, and the test asserts `/stock` shows its fallback — with `strict: true`, so an exception or unhandled rejection from the failed fetch fails the test too.

URLs are relative (`chaos.testPage(page, "/about")`, `chaos.crawl("/")`): the fixture resolves them against `use.baseURL` in `playwright.config.ts`, as `page.goto` does.

The fixture site server boots automatically via `playwright.config.ts`'s `webServer` block — `pnpm test` is one command end-to-end.

## Run it

```bash
pnpm install
pnpm exec playwright install chromium
pnpm test
```

Or interactively:

```bash
pnpm test:ui
```

The third test (`crawl finds a broken link`) is intentionally written to *expect* the broken link, so the run passes. Replace `expect(() => chaos.expectNoDeadLinks(report)).toThrow(...)` with `chaos.expectNoDeadLinks(report)` to make it fail when a broken link slips in — that's the shape you'd want in CI.

## Files

```
.
├── README.md
├── package.json
├── tsconfig.json
├── playwright.config.ts   # boots the fixture site as webServer
├── site/
│   └── server.mjs         # small static server (the SUT)
└── tests/
    ├── chaos.spec.ts      # both integration patterns, and a fault, one file
    └── recipes.spec.ts    # the recipes fixture, same shape
```

## When to use each pattern

| Pattern | Best for |
|---|---|
| `chaosTest` | Files that exist *for* chaos coverage. Crawl sweeps, dead-link checks, regression suites that fail on console errors anywhere on the site. |
| `withChaos()` extension | Files that are mainly regular Playwright Tests but want one chaos check as a finisher (e.g. "after exercising the form, also crawl the surrounding pages"). |

The `withChaos()` extension is `base.extend(withChaos({ maxPages: 5 }))` — `withChaos()` returns a fixture object Playwright Test stitches onto your `base` test.

## Related

- [`packages/chaosbringer/README.md`](../../packages/chaosbringer/README.md#playwright-test-integration) — full fixture API reference (`ChaosFixture`, `ChaosFixtures`, `chaosExpect`).
- [`examples/cloudflare-worker/`](../cloudflare-worker/) — programmatic `chaos()` driver instead of Playwright Test integration. Use that when the chaos run is its own CI step rather than part of an `@playwright/test` suite.
