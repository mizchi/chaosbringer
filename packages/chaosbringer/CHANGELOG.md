# Changelog

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
