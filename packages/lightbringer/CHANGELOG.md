# Changelog

## [0.5.0](https://github.com/mizchi/chaosbringer/compare/lightbringer-v0.4.0...lightbringer-v0.5.0) (2026-10-07)

### ⚠ BREAKING CHANGES

* `web-vitals` ^6 (was ^5).

### Features

* `hostLocale()` is exported from `lightbringer/core`: the host's locale as a valid BCP 47 tag (`en-US@posix` becomes `en-US`).

### Bug Fixes

* **Long tasks before a navigation are kept on Chromium 153 (Playwright 1.63).** The binding call an unloading document makes on `pagehide` no longer reaches node there. The collector now also pushes long tasks, animation frames, span measures and interactions as soon as they are recorded.
* **Render counters of a span that navigated are no longer negative.** Chromium 153 restarts CDP's cumulative counters on a cross-document navigation. A counter that went down is read as what it counted since the restart; `Nodes` stays a plain delta.

### Build

* Built with tsdown instead of tsup, so the type declarations build on TypeScript 7. The output files and their names are unchanged.
* The `playwright` dependency is `^1.59.0`.

## [0.4.0](https://github.com/mizchi/chaosbringer/tree/lightbringer-v0.4.0/packages/lightbringer) (2026-10-01)

lightbringer now lives in [mizchi/chaosbringer](https://github.com/mizchi/chaosbringer/tree/main/packages/lightbringer), where chaosbringer measures every crawl step with it. 0.3.1 was the last release from mizchi/lightbringer.

### Features

* `lightbringer/core`: a runner-agnostic core that does not import `@playwright/test`, with a per-span drain for callers that measure many steps on one page. `lightbringer/fixture` holds the `@playwright/test` fixture; `.` still exports both. ([#150](https://github.com/mizchi/chaosbringer/pull/150))
* Page-level metrics: Web Vitals, layout shifts, render-blocking resources, third-party weight. ([#159](https://github.com/mizchi/chaosbringer/pull/159))
* `PerfSession.requests()`: a snapshot of every captured request, in start order, so a caller can find the span a request started in. ([#175](https://github.com/mizchi/chaosbringer/pull/175))
* Network traffic of out-of-process iframes is counted. ([#164](https://github.com/mizchi/chaosbringer/pull/164))

### Bug Fixes

* A failed request is kept in the span's request list, with its duration up to the failure and `failed: true`. ([#170](https://github.com/mizchi/chaosbringer/pull/170))
* "Uncompressed text" skips content types and extensions that are already compressed, and decides by the CDP MIME type, so binary files served without a type are not flagged. ([#170](https://github.com/mizchi/chaosbringer/pull/170), [#173](https://github.com/mizchi/chaosbringer/pull/173))
* The measurement and settle fixes from chaosbringer's perf evaluation. ([#155](https://github.com/mizchi/chaosbringer/pull/155), [#157](https://github.com/mizchi/chaosbringer/pull/157))
