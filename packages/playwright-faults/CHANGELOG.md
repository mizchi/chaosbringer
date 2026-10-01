# Changelog

## [0.3.0](https://github.com/mizchi/chaosbringer/compare/playwright-faults-v0.2.0...playwright-faults-v0.3.0) (2026-10-01)

### Features

* Iframe-load fault injection: `IframeFault`, `compileIframeFaults`, `buildIframeFaultsScript`, `mergeIframeStats`. ([#132](https://github.com/mizchi/chaosbringer/pull/132))
* Deterministic, occurrence-indexed fault decisions shared by all four layers: `FaultSchedule`, `decideFault`, `scheduleDecisionAt`, `buildDecisionHelperSource`, `validateFaultSchedule`. ([#135](https://github.com/mizchi/chaosbringer/pull/135))
* `compileUrlMatcher` and `stripStatefulFlags` are exported for consumers that compile their own rules. ([#135](https://github.com/mizchi/chaosbringer/pull/135))
* `FaultRule.resourceTypes` limits a network rule to Playwright resource types (`["fetch", "xhr"]`); a request of unknown type does not match a limited rule. ([#172](https://github.com/mizchi/chaosbringer/pull/172))

### Bug Fixes

* The stats readers (`mergeRuntimeStats`, `lifecycleStatsFrom`, `mergeIframeStats`) say when they are handed raw faults instead of compiled ones, rather than returning `NaN` or empty rows. ([#136](https://github.com/mizchi/chaosbringer/pull/136))
* Occurrence numbering means the same thing on all four layers: a scheduled fault behind one that claimed the request still advances. ([#136](https://github.com/mizchi/chaosbringer/pull/136))

## [0.2.0](https://github.com/mizchi/chaosbringer/compare/playwright-faults-v0.1.0...playwright-faults-v0.2.0) (2026-05-16)


### Features

* extract @mizchi/playwright-faults (network / lifecycle / runtime) ([#51](https://github.com/mizchi/chaosbringer/issues/51)) ([b642aa5](https://github.com/mizchi/chaosbringer/commit/b642aa5cb0f677519f712f0a7a41e438857ebaca))
