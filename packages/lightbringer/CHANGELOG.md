# Changelog

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
