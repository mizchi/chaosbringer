# Changelog

## [0.8.1](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.8.0...chaosbringer-v0.8.1) (2026-05-06)


### Bug Fixes

* **publish:** rewrite `workspace:^` refs in the published `package.json` (use `pnpm publish`, not `npm publish`). 0.8.0 shipped with `@mizchi/playwright-faults: workspace:^` literally, which breaks installs at consume time. Use 0.8.1 instead.

## [0.8.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.7.0...chaosbringer-v0.8.0) (2026-05-06)


### Features

* **chaosbringer:** add chaos({ setup }) pre-run hook for state seeding ([2432558](https://github.com/mizchi/chaosbringer/commit/24325580e2dcf25f17101767fcf4ad17d80ea30b))
* **chaosbringer:** add ChaosRemoteServer option type (no behaviour yet) ([62b19bc](https://github.com/mizchi/chaosbringer/commit/62b19bcf9559f286871e4273274f29db64f29b5a))
* **chaosbringer:** collect server-fault events from response headers per page ([31b3bc0](https://github.com/mizchi/chaosbringer/commit/31b3bc0fdd30c1c5460c8e6fcde8460349131973))
* **chaosbringer:** inject W3C traceparent for OTel correlation ([a76a485](https://github.com/mizchi/chaosbringer/commit/a76a48523afdab28f77250fad0ce1b68e85deddc))
* **chaosbringer:** named fault profiles for shared operator knowledge ([bb1f7dc](https://github.com/mizchi/chaosbringer/commit/bb1f7dc3b563a313098eb5825ceb1bbdb15af153))
* **chaosbringer:** parse x-chaos-fault-* response headers into events ([214b9a3](https://github.com/mizchi/chaosbringer/commit/214b9a379b7ac0cb3fcbaad0ceaf3c23beacc22b))
* **chaosbringer:** per-page + per-action server-fault correlation ([#56](https://github.com/mizchi/chaosbringer/issues/56) Phase 2) ([#79](https://github.com/mizchi/chaosbringer/issues/79)) ([7c3d7f9](https://github.com/mizchi/chaosbringer/commit/7c3d7f96aace1f6b23f7c6af914d726a28f69951))
* **chaosbringer:** surface server fault events on CrawlReport.serverFaults ([0f39f97](https://github.com/mizchi/chaosbringer/commit/0f39f97a73134ea9c305684874b991864a80d807))
* extract @mizchi/playwright-faults (network / lifecycle / runtime) ([#51](https://github.com/mizchi/chaosbringer/issues/51)) ([b642aa5](https://github.com/mizchi/chaosbringer/commit/b642aa5cb0f677519f712f0a7a41e438857ebaca))
* extract V8 coverage primitives to @mizchi/playwright-v8-coverage ([#50](https://github.com/mizchi/chaosbringer/issues/50)) ([80a7d20](https://github.com/mizchi/chaosbringer/commit/80a7d2026a9887fb6815c045de9026fcf154f8d2))


### Bug Fixes

* **chaosbringer:** alias ServerFaultEvent.attrs to ServerFaultEventAttrs + drop redundant cast ([54231c0](https://github.com/mizchi/chaosbringer/commit/54231c0ebf6f55aef00483405fe0108efc2158ec))
* **chaosbringer:** align serverFaults field style + drop redundant shape test ([d2cb30a](https://github.com/mizchi/chaosbringer/commit/d2cb30af6776f593eec85a5f7b0c875fead0ff01))
* **chaosbringer:** derive ServerFaultKind from as-const tuple + prefix-isolation test ([1bf0b43](https://github.com/mizchi/chaosbringer/commit/1bf0b43a693beef4b33f6686727f8aa6e153a3a7))
* **chaosbringer:** validate options before invoking the setup hook ([e51606b](https://github.com/mizchi/chaosbringer/commit/e51606bdc9a7fb69f2c7a64eccad79e732d66ead))

## [0.7.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.6.0...chaosbringer-v0.7.0) (2026-05-01)


### Features

* **advisor:** CLI cost / call summary in formatReport + formatCompactReport ([#47](https://github.com/mizchi/chaosbringer/issues/47)) ([6bcb035](https://github.com/mizchi/chaosbringer/commit/6bcb035776d66384854da958d6ca710407f39523))
* **advisor:** redactReasoning flag for confidential UIs ([#45](https://github.com/mizchi/chaosbringer/issues/45)) ([001e4a1](https://github.com/mizchi/chaosbringer/commit/001e4a1b80aa4e14875923ab9bb9560416474dd0))
* **advisor:** screenshotMode config (viewport | fullPage) ([#46](https://github.com/mizchi/chaosbringer/issues/46)) ([5932a53](https://github.com/mizchi/chaosbringer/commit/5932a538259add28618c07a54432a0f7ac8c6568))
* replay fidelity tracking — surface trace UI drift ([#48](https://github.com/mizchi/chaosbringer/issues/48)) ([5017733](https://github.com/mizchi/chaosbringer/commit/50177332c0d0f022a7a98f38da6b697195674d9f))

## [0.6.0](https://github.com/mizchi/chaosbringer/compare/v0.5.0...v0.6.0) (2026-05-01)


### Features

* **advisor:** opt-in VLM (vision-language model) action advisor that picks the next action from a candidate list when the coverage-guided heuristic stalls. Default reference provider is OpenRouter `google/gemini-2.5-flash`. Off by default; configure via `CrawlerOptions.advisor`. Soft-failure on every recoverable problem; falls back to heuristic. ([#38](https://github.com/mizchi/chaosbringer/pull/38), [#39](https://github.com/mizchi/chaosbringer/pull/39), [#40](https://github.com/mizchi/chaosbringer/pull/40), [#41](https://github.com/mizchi/chaosbringer/pull/41))
* **report.advisor:** new `CrawlReport.advisor` block (provider, callsAttempted, callsSucceeded, picks). Each pick records the URL, reason (`novelty_stall` / `invariant_violation` / `explicit_request`), chosen selector, and model reasoning.
* **trace:** advisor-driven actions are stamped into the JSONL trace with `{provider, reason, reasoning}`. Replays use the recorded selector verbatim — model is not re-consulted.


### Build / repo

* repo converted to a pnpm workspace ([#42](https://github.com/mizchi/chaosbringer/pull/42)). Source moved to `packages/chaosbringer/`. No effect on the published npm package contents.

## [0.5.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.4.0...chaosbringer-v0.5.0) (2026-05-01)


### Features

* coverage-guided action selection (AFL-style V8 precise coverage feedback) ([a5d981a](https://github.com/mizchi/chaosbringer/commit/a5d981a419c384e6e9aef55952d6239fcbb67566))
* lifecycle fault injection (CPU throttle, storage wipe, cache eviction, tamper) ([c0a435d](https://github.com/mizchi/chaosbringer/commit/c0a435dbe32bec99f370e79bc9068aa57430008e))
* state-machine invariants + trans-page ctx.state ([06fb150](https://github.com/mizchi/chaosbringer/commit/06fb150920a6931283994fa02c43bf88b5723e0e))
