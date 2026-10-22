# Changelog

## [0.14.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.13.0...chaosbringer-v0.14.0) (2026-10-21)

Fixes for load runs against a host that is down, faults that never fired, reproduction commands that dropped faults, and the subcommands' exit codes. See [#191](https://github.com/mizchi/chaosbringer/pull/191) and [#192](https://github.com/mizchi/chaosbringer/pull/192).

### ⚠ BREAKING CHANGES

* **A subcommand's usage error exits 2, not 1.** An unknown flag or `perf` / `model` subcommand, a missing required flag or operand, or a malformed value of a flag the subcommand checks now prints one `chaosbringer <sub>: … (see chaosbringer <sub> --help)` line and exits 2 before anything runs, as the main command does. It was `<sub> failed: …`, `Error: …` (`flake`, `minimize`), or the subcommand's own line or help text, and exit 1, so `scan --bogus` read as a scan that found something. Apart from `minimize`, `load` and `recipes verify` below, what a subcommand reports about the run keeps its code.
  * `recipes show`, `history`, `promote`, `demote`, `delete`, `prune`, `rollback`, `verify`, `diff` and `repair` without a name, and `recipes harvest` without a URL, exit 2. They printed their usage line and exited 0. `recipes rollback` without `--to-version` exits 2; it printed `Rollback failed: <name>@v0 not found` and exited 1. Their integer flags (`--version`, `--keep-last`, `--to-version`, `--runs`, `--from-version`, `--context`, `--seed`, `--repair-budget`) and `--min-success-rate` are checked: `recipes prune <name> --keep-last abc` used to run and exit 0. An empty value is refused too; an empty `--min-success-rate` meant the default 0.8.
  * `flake --max-pages`, `--max-actions` and `--timeout` go through the main crawl's number checks. `flake --max-pages abc` printed `Run 1/3...`, failed inside the crawler and exited 1, the code `flake` uses for a flaky run. An empty `--max-pages` or `--timeout` is still read as unset. An empty `--max-actions` now is too; it meant 0.
  * `drive` checks `--max-steps`, `--hang-ms` and, with `--chaos`, `--faults` before it drives (`--faults` and `--hang-ms` were read only after the drive, under `--chaos`). A missing API key or an unknown `--provider` exits 2.
  * `model compile`, `run`, `calibrate` and `shrink` print one line for a missing required flag instead of the whole help on stdout. `model shrink` checks `--target`, `--max-runs` and `--retries` before it reads the plan.
  * `parity` checks `--perf-samples` and `--perf-percentile` before it reads `--paths`.
  * `scan`'s refusal of a positional argument reads `unexpected argument "<word>": scan takes no positional arguments`.
  * `perf emit-budgets`, `gate` and `regress` exit 2 for a usage error, as they already did for `refusing to compare: …`. A CI step that reads their exit 2 as "not comparable" should also look for that line.
  * `shard` checks the flags it forwards before any worker starts (see Bug Fixes).
  * `load`'s own checks, `drive` without `--url` / `--goal`, `recipes verify` / `repair` without a usable `--base-url`, and an unknown `recipes` subcommand already exited 2. Their message is now the one line, and `load` no longer prints its help after it.
* **`minimize` exits 1 and writes nothing when the failure does not reproduce.** It ran the search anyway, reported success with exit 0 and wrote the trace unshrunk. It now prints `chaosbringer minimize: the failure did not reproduce: …`.
* **Load runs and `recipes verify` stop when they cannot connect to the base URL, and a store load with nothing to replay does not start.**
  * `scenarioLoad` stops once 3 iterations in a row, across all workers, failed with a connection-level net error on a navigation to `baseUrl`'s origin (`net::ERR_CONNECTION_REFUSED`, `ERR_NAME_NOT_RESOLVED`, `ERR_ADDRESS_UNREACHABLE`, `ERR_UNSAFE_PORT`, …). Every worker finishes the step it is in, and the report carries `stopped`. It used to fail every iteration until `duration` ran out. `stopOnUnreachable` (on `scenarioLoad` and `scenarioLoadFromStore`) sets the streak, and `false` turns the stop off.
  * `evaluateSlo` / `assertSlo` report a stopped run as a violation (`metric: "stopped"`), listed first, whatever the thresholds. Its numbers cover only what ran before the stop, and 3 refused iterations after a few hundred good ones could pass an error-rate SLO.
  * `chaosbringer load` exits 2 when the run stops early, after printing the report (unless `--quiet`) and writing `--output`. The report says `stopped early: <reason>`, as `formatLoadReport` does, and the last stderr line is `load: <reason>`. It also exits 2, before Chromium starts, when the store has no recipe of `--filter-status` (`load: no verified recipes in <dir> — nothing to replay`).
  * `recipes verify` exits 2 when a replay cannot connect to `--base-url`, prints `verify: base URL unreachable: <url> (…); <name> left as it was`, and records nothing. It recorded every run as a failure, demoted the recipe and exited 1. `verifyAndPromote` returns `unreachable` then (new `VerifyResult.unreachable`). It also records its runs' stats after the last run, not after each one.
  * `scenarioLoadFromStore` throws before it launches a browser when no recipe is eligible.
  * New: `ScenarioLoadOptions.stopOnUnreachable`, `LoadReport.stopped`, type `LoadStop`.
* **`scenarioLoad` waits after a failed iteration.** Whatever failed it, the worker waits the failed step's think time, at least 100 ms, before the next iteration. It started the next one at once. A run whose iterations fail runs fewer of them in the same `duration`, with lower iteration and failure counts and throughput, which can change a `minThroughputPerSec`, `maxIterationFailures` or error-rate SLO result.
* **`shard` prints and writes the merged run.**
  * `shard --quiet` prints the merged verdict, why it failed, the paths written and `Merged report saved to:`, as the main command's `--quiet` does, and `N/M shard(s) exited non-zero` when a worker did. It printed the whole merged report and no saved line. `shard --compact` prints the merged compact report without the workers' own output mixed in. Both print the paths the workers wrote once, with the bundle counts summed per directory, and `JUnit XML saved to:` comes after `Merged report saved to:`.
  * `--junit`, `--heatmap-out` and the `--cluster-artifacts` bundles are written again from the merged report once the workers are done. Every worker wrote them to the same path, so the file held whichever shard finished last: `tests="6"` for a merged report of 10 pages. A CI step that reads shard's `--junit` now sees every shard's pages, failing ones it did not see before included.
* **A `reproCommand` can end in a shell comment.** When a run sets fault rules or invariants in code, its `reproCommand` and `Repro:` line end in `# + …` (see Bug Fixes). A flag appended to the command falls inside the comment and is ignored, and a caller that splits the command without a shell passes the `#` on, which the CLI refuses with exit 2.
* **`perf drilldown` on a `scan` chaos report needs `--perf-dir`.** The report's command no longer has `--perf-out`, which is where `perf drilldown` found the per-page sidecars. Only a `runScan` with `perf.level: "trace"` records a trace to drill into. Pass `--perf-dir <out>/perf/<status|abort|hang>`.
* **The Playwright Test fixture refuses a misspelled `chaosOptions` key, and a `ChaosCrawler` option it does not take.** A misspelled key (`maxActionPerPage`, `stirct`) throws `chaosbringer: unknown chaosOptions key "stirct" — did you mean "strict"? …` as the fixture is set up, and so does `runChaosTest()`. A `ChaosCrawler` option the fixture does not take (`timeout`, `iframeFaults`, `headless`) throws too, naming the keys it takes. Both used to be dropped without a word: `maxActionPerPage: 0` ran 5 actions a page, and `stirct: true` failed nothing. A key that is neither close to a fixture option nor a crawler option (`foo`) is still ignored.
* **With `faultInjection` set, network rules also match the requests a service worker makes.** A request a service worker's `fetch` handler takes never reached the page's route. On a PWA, a `faults.status(500)` on `/api/data` matched 0 while the server answered every request, and the run passed. The crawl now also routes the context it launched. The worker's requests (those it forwards to the network, the worker script itself, its precache requests) go through the same rules, counters and occurrence numbering as the page's, ahead of `--har-replay`. A forwarded request has `resourceType` `"fetch"` whatever the page asked for.
  * A catch-all rule can now fail the worker script.
  * A `probability` rule draws from the RNG for each of these requests, so a pinned seed on such a site gives a different action sequence.
  * The worker's requests skip the HTTP cache, as the pages' already did.
  * None of this applies on an attached browser (`cdpEndpoint`, `terminalBrowser`) or with `PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK` set.
* **`MinimizeResult.reproduced` and `ScanReportFile`'s `chaos[].reproCommand` are required fields.** Code that builds either object must set them, and a `scan-report.json` written by 0.13.0 has no `reproCommand`.

### Features

* **`ScenarioContext.stopRun(reason)` ends a load run from a step.** Every worker stops at its next step boundary, and the report records `stopped` with `cause: "scenario"`. It does not fail the step that calls it, and it fails `evaluateSlo` / `assertSlo` like any stopped run. It is optional on the type (`scenarioLoad` always sets it), so call it as `ctx.stopRun?.(reason)`. `recipeStoreScenario` calls it when no recipe is eligible any more.
* **`load --no-record` leaves the recipe store as it was.** Replays are still recorded by default, as in 0.13.0. In code, pass `record: false` to `recipeStoreScenario`, `recipeStoreScenarioWithStats` or `scenarioLoadFromStore` (`RecipeStoreScenarioOptions.record`).

### Bug Fixes

* **`load` against a host that is down no longer rewrites the store and crashes.** Against a port nothing listened on, 0.13.0 recorded every replay as a failure, which took the verified recipe out of `verified` on disk mid-run. Every iteration after that threw `no verified recipes match filter` without touching the browser, the workers looped tens of thousands of times a second, and `load` exited 1 with `load failed: Maximum call stack size exceeded` and no report. Now:
  * a replay whose navigation could not connect to the base URL is not recorded into the store, while any other failure still is;
  * a failed iteration waits before the next (see BREAKING CHANGES);
  * a run with a few hundred thousand samples (a long run, or one that fails fast) still gets its report, where building it threw `Maximum call stack size exceeded`;
  * the run stops on a streak of unreachable iterations (see BREAKING CHANGES).

  "Could not connect" means a connection-level net error on a request to the base URL's origin itself. A redirect the site answered with to a host that is down (an SSO page, a payment provider) counts as the site's failure. So does `ERR_CONNECTION_RESET`, because the host accepted that connection. In `scenarioLoad`, an iteration that failed on a navigation a `faultInjection` rule aborted (`faults.abort({ urlPattern: …, errorCode: "connectionrefused" })`) neither counts toward the stop nor resets it.
* **`load --filter-status candidate|demoted` replays recipes of that status.** It filtered the verified recipes by that status and found none: every iteration threw `no verified recipes match filter` at once, and the run ended in `load failed: Maximum call stack size exceeded` with no report, as against a host that is down. With recording on, a replay can move a recipe out of that status: a candidate that passes often enough is promoted, and a demoted recipe with 5 or more recorded runs becomes `candidate` (or `verified`) on its next recorded replay. The run stops with exit 2 once none is left. Pass `--no-record` to load-test candidates or demoted recipes for the whole `--duration`. New `RecipeStoreScenarioOptions.status` (default `"verified"`).
* **Fault counts that said nothing fired:**
  * `testPage()` counts the runtime and iframe faults that fired on its page. Their in-page counters were read on the crawl's own pages only, so a `start()` on the same crawler after `testPage()` reported 0 for them. `testPage()` returns no report, so the new `ChaosCrawler.getRuntimeFaultStats()` and `getIframeFaultStats()` return the counts in the report's row shape.
  * When network rules are configured, a page a service worker controlled at the end of its visit records `PageResult.serviceWorker` (`"routed"` or `"unrouted"`). For a network rule that matched nothing, `unfiredFaults` then names the worker as a possible cause instead of blaming the pattern. `fault_rule_unmatched` (and `faultWarnings()`) carries `serviceWorker: { reach, pages }`. `"unrouted"` means `testPage()` on your own context, an attached browser, or a crawl with `PLAYWRIGHT_DISABLE_SERVICE_WORKER_NETWORK` set. New type `ServiceWorkerReach`.
  * `unfiredFaults`, `faultWarnings` and `faultFirings` take a report built by hand, typed by the new `FaultStatsReport`; a `CrawlReport` still fits it. They took a whole `CrawlReport`, so stats collected another way failed to typecheck (TS2740), such as a `faults` session's `{ faultInjections: session.stats(), runtimeFaults: await session.runtimeStats() }`. After `testPage()`, pass `{ faultInjections: crawler.getFaultStats(), pages: [result] }`.
* **Reproduction commands say what they cannot carry.**
  * A run can set fault rules (network, lifecycle, runtime, iframe) or invariants in code. Its `reproCommand` and `Repro:` line then end in a shell comment that counts them and names them as their stats do: `chaosbringer --url … --seed 42 # + 1 fault rule not expressible on the CLI: api-500`. `repro.sh` gets the same text as a comment line. They used to be dropped without a word, so the command reran the run clean and it passed. An unnamed rule is named by its compiled pattern (`/\/api\//` for `"/api/"`). The invariants that `--axe` and `--visual-baseline` build are not counted. `buildReproScript` takes `note`.
  * A `scan` chaos crawl's report (`chaos-<status|abort|hang>-report.json`) holds the `chaosbringer scan --url … --seed … --faults <500|abort|hang> …` command that reruns it, with the scan flags that shape the crawls. It held the plain crawl's command, which has no flag for the scan's fault rule, so a high resilience finding reran as `[PASS]`.
    * The command's comment also names the `runScan` options set in code that change the crawls and have no scan flag, as `crawler.<option>` / `perf.<option>`: `crawler.spaPatterns`, a HAR replay, `crawler.httpCache: false`, a `crawler.settle` other than `"adaptive"`, `crawler.actionWeights` that change a weight, `perf.memory`, ….
    * `scan-report.json`'s `chaos[]` entries carry the command as `reproCommand`, and `scan-report.md` lists it after each chaos report.
    * `clean-report.json`'s command, still a plain crawl, carries `--axe` when the scan ran with `--axe`. It left the check out.
  * The shell can pass a pasted comment on as arguments (zsh without `setopt interactivecomments`). The main command (which already refused it with exit 2) and `scan` now refuse it with a line saying the shell passed a comment on, and to drop the `#` and everything after it.
* **`minimize` checks that the failure reproduces before it shrinks.** It ran ddmin without replaying the whole trace first. A `--match` that never matched took a 9-action trace through 38 replays (1m39s) and printed `Reduced 9 → 9 actions over 38 replays`. `minimize` now replays every action first and stops there when that does not match (one replay, 4 s). It then replays no actions at all, which ddmin never tries, so a failure on the page loads alone minimizes to no actions instead of one. `MinimizeResult` gains `reproduced`, and `minimizeActions` is a new export. The `iter=` progress lines count those two replays, as the summary's total does.
* **`shard`:**
  * every worker gets the same `--seed`, the one given or one drawn for the run, and the merged report's `Repro:` line is `chaosbringer shard --count N …`. Unseeded workers each drew their own seed, and the line was shard 0's (`… --shard 0/2`), which reran shard 0 alone;
  * the flags it forwards get every check the main command makes before its browser starts (`--heatmap-top`, `--cluster-artifacts` without `--failure-artifacts`, the `--perf-budgets` file), and a refusal exits 2 once. Each of the N workers refused it, and the run ended in `could not read …/shard-0.json` and exit 1;
  * it no longer leaves a `/tmp/chaos-shard-*` directory behind.

### CLI output

* The crawl prints `Wrote N failure bundle(s) to <dir>/`, `Trace saved to: …` and `Log saved to: …` next to `Report saved to:`, in every output mode. No output mode named the failure bundles, the `--trace-out` file or the `--log-file`, though `--quiet`'s help promises the paths written. The bundle line comes only when the run wrote a bundle. A `--failure-artifacts` ending in `/` no longer prints `out//`, which the cluster bundle line did. New `CrawlerEvents.onFailureBundle(bundleDir, result)`.
* `scan`'s where column and summary count other places in `(+N)`, not other errors: four throws on one page read `/multi (+3)`, as if four pages had thrown, and now read `/multi`. `ScanFinding.places` (optional) counts the distinct places before the cap. For a finding without it, such as one from a 0.13.0 `scan-report.json`, the formatters count `where`.
* `--help` says `--strict` fails on console errors, JS exceptions and unhandled rejections. It said "any console errors".
* `load --help` and `recipes verify --help` list their exit codes, and `drive --help` and `parity --help` add exit 2 to theirs. `shard --help` says which flags it checks and which files it writes again from the merged report.

### Packaging

* Depends on `lightbringer` ^0.5.1 (was ^0.5.0). Its `@playwright/test` peer is now `^1.59.0`, the range chaosbringer already requires.

## [0.13.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.12.1...chaosbringer-v0.13.0) (2026-10-18)

Fixes for results that were hidden, misattributed or impossible to reproduce. See [#187](https://github.com/mizchi/chaosbringer/pull/187) and [#188](https://github.com/mizchi/chaosbringer/pull/188).

### ⚠ BREAKING CHANGES

* **A bad invocation of the main crawl command exits 2, not 1.** An unknown or malformed flag, a missing `--url`, a stray argument, an option combination `validateOptions` refuses, or a `--perf-budgets` file that cannot be used now prints one `chaosbringer: …` line and exits 2. An unknown flag or bad number used to print a stack trace. Subcommands (`scan`, `diff`, `drive`, `load`, `recipes`, …) keep their own handling and exit 1.
  * Number flags are strict: `--timeout 5s`, `--max-pages 3x`, `--max-actions 1.5` and `--timeout 0` are refused, where `parseInt` used to accept them. `--heatmap-top` and `--cluster-min-count` are checked before the crawl.
  * `--cluster-artifacts` without `--failure-artifacts` now fails before the crawl rather than after it.
  * `recipes verify`, `repair` and `load` exit 2 when `--base-url` is not an absolute http(s) URL.
* **`--junit` writes timed-out and errored pages as `<failure>`, not `<error>`.** They keep `type="timeout"` / `type="error"` and their message, and the suite's `errors` count is always 0. flaker 0.14's import only looks for `<failure>`, so these pages were recorded as passed. Allure now shows them as Failed rather than Broken, and GitLab as failed rather than error.
* **`--quiet` prints only the verdict line and the paths written**, plus one line saying why a failing run failed. It used to print the full report.
* **A server fault event's `attrs.kind` can be `"partial"` or `"slowStream"`.** A `switch` over `ServerFaultEvent["attrs"]["kind"]` that was exhaustive needs the new cases.
* **Recipes are replayed on the base URL they are given.** `recipes verify`, `repair`, `load`, `recipeDriver`, the recipe-store load scenarios (`recipeStoreScenario`, `scenarioLoadFromStore`) and the Playwright Test fixture rebase a recipe's recorded origin onto `--base-url` / `baseUrl`, and a repaired recipe is saved with the new origin. The fixture defaults to the test's http(s) `baseURL`, and `recipeDriver` to the origin of the page the recipe matched on; pass `baseUrl` to choose another.
* **The Playwright Test fixture's `strict: true` now fails the test.** It was documented and never read, so suites that set it may start failing on errors they had been passing with.

### Bug Fixes

* **Recipes recorded by `drive` reported success against hosts they never reached.** A recipe whose first step navigates to an absolute URL went there whatever `--base-url` said, so `recipes verify --base-url <unreachable>` printed `ok … promoted=true` and `load` reported zero failures. Replay now rebases same-origin steps (cross-origin ones stay put), and the CLI prints a warning to stderr when it does (not under `--quiet`). `runRecipe`, `verifyAndPromote`, `repairRecipe`, `runRecipeWithRequires` and the recipe driver and fixture options take `baseUrl`. `drive`'s "verify it with" hint includes `--base-url`, and `--dir` when the store is not the default. New exports: `rebaseRecipe`, `recipeOrigin`.
* **The Playwright Test fixture (`chaosbringer/fixture`):**
  * reads Playwright's `baseURL`, so `chaos.crawl("/")` and `chaos.testPage(page, "/")` resolve relative URLs. It used to read the first page's `about:blank` and throw `Invalid URL`;
  * applies `strict`, through the same rules as the CLI's exit code;
  * takes `seed`, `invariants`, `faultInjection`, `lifecycleFaults` and `runtimeFaults`;
  * attaches the crawl report to the test as `chaos-report.json`.

  The README now imports it from `chaosbringer/fixture`.
* **`testPage()` on a page the caller owns:** runtime, iframe and caller init scripts are now installed on it before it navigates, and stay on it. They were only put on the crawl's own context, so runtime faults never ran there. A second `testPage()` no longer applies its lifecycle faults to the previous page.
* **`--axe` / `invariants.axe()`:**
  * axe-core is injected over CDP, which a page's Content-Security-Policy does not govern. An inline script tag was refused by a strict `script-src`, and every page of such a site failed with an injection error that had nothing to do with accessibility;
  * iframes are scanned too, with the frame's URL in the message and violations counted per rule per frame. This needs axe-core 4.3 or later (older versions scan the top document only), and cross-origin frames are reached only with `blockExternalNavigation: false`. Frames sandboxed without `allow-scripts` are skipped, and each frame's scan is bounded at 10 s. `formatAxeViolations` takes an optional `frameOf`.
* **server-faults `partial` and `slowStream` events reach the report.** The header parser knew only `5xx` and `latency` and dropped the rest. `ServerFaultEventAttrs` gains `afterBytes`, `chunkDelayMs` and `chunkSize`.
* **Reproduction commands carry every flag that shapes the run.**
  * A failure bundle's `repro.sh` carried only `--url` and `--trace-replay`. It now `cd`s to its own directory and has the run's other options (all but `--seed` and `--trace-out`), with input files resolved against the run's directory.
  * `reproCommand` adds `--aria-targets`, `--no-http-cache`, a non-default `--timeout`, `--har-replay`, the ignore patterns (as `--ignore-analytics` / `--ignore-preset` where they match), and from the CLI `--strict`, `--axe` / `--axe-tags`, the `--visual-*` flags and `--allow-settle-mismatch`.
  * Values with `?`, `&` or a leading `=` are now quoted, and a value starting with `-` is written `--flag=-x`. New exported type: `ReproFlag`.
* **"Failed to load resource" names the resource.** The console error carries `resourceUrl`, shown in the text report, cluster samples (`resourceUrls`) and scan evidence. Its type and message are unchanged, so existing `--baseline` files still compare.
* **JUnit output stays well-formed XML.** ANSI colour codes (Playwright's call log has them) and other control characters XML cannot carry are dropped. One ESC byte made strict parsers reject the whole file.

### CLI output

* `--compact` counts every error kind, unhandled rejections and invariant violations included. On FAIL it says why, lists the clusters behind it (those that failed the run first), and prints the Repro line. It could print `[FAIL] 1 pages, 0 errors`. `formatCompactReport` returns the same.
* `--compact` progress is written one line per page when stdout is not a terminal, instead of `\r` updates that ran together in CI logs.
* `--version` / `-V`, and `-h` for `--help`.
* `--help` lists every subcommand.
* `scan` warns about a near-empty start page only when the crawl did not get past it.
* `diff` calls clusters present on both sides "Shared" (was "likely third-party noise"), and shows a raw sample message where it differs from the normalised key; `diff --json` carries a `sample` for each.
* `scan`'s "… and N more" counts the items left out, not occurrences, and `ScanFinding.unlisted` carries that count.

## [0.12.1](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.12.0...chaosbringer-v0.12.1) (2026-10-10)

See [#184](https://github.com/mizchi/chaosbringer/pull/184).

### Bug Fixes

* **`--junit` output imports into flaker 0.14 page for page.** Passing pages are now written `<testcase …></testcase>` instead of self-closed. flaker's parser read a self-closed testcase followed by a failing one as a single failed testcase, so a 10-page crawl imported as 8 results with a passing page marked failed.
* **`perf regress` refuses to compare when no perfKey appears on both sides** (exit 2, like the other comparability checks). It used to report "no regressions" having compared nothing.
  * It also prints how many perfKeys it compared, how many appear on only one side, and the browser on each side.
  * `--json` adds `comparedKeys`.

### Packaging

* The tarball ships `dist` only: no `src`, no source maps. That is 340 files and 621 KB, down from 823 files and 1.3 MB. The type declarations are unchanged.

## [0.12.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.11.2...chaosbringer-v0.12.0) (2026-10-07)

Browser automation on Playwright 1.63. See [#180](https://github.com/mizchi/chaosbringer/pull/180), [#182](https://github.com/mizchi/chaosbringer/pull/182) and the dependency update.

### ⚠ BREAKING CHANGES

* **`playwright` / `@playwright/test` peer ranges are now `^1.59.0`** (were `^1.40.0`). `drive` and the accessibility-snapshot features use `page.ariaSnapshot({ mode: "ai" })` and `page.screencast`, both from 1.59. Tested on 1.63 (Chromium 153).
* Needs `lightbringer` 0.5.0.

### Features

* **`chaosbringer drive --url <url> --goal "<task>"`** operates a browser towards a goal, one action at a time ([docs](https://github.com/mizchi/chaosbringer/blob/main/docs/recipes/drive.md)).
  * Each step, a model (`anthropicDecider` / `openRouterDecider`) or a model-free `--plan` reads the page's accessibility snapshot: an outline, plus numbered controls with their state and where they sit. It answers with click, fill (with its own text), select, press, done or give up.
  * The crawl's checks run on every step: exceptions, unhandled rejections, console errors, failed requests and 5xx. They are shown to the model; errors this machine causes are kept apart.
  * With `--until-url` / `--until-text`, "done" is accepted only while the condition holds.
  * A run that reaches its goal is written as a recipe with role selectors. `chaosbringer recipes verify` replays it.
  * `--video` records the run with every action annotated (`page.screencast`).
* **`drive --chaos`** replays that journey clean, then with the app's own API calls failing (500 / abort / hang). It reports:
  * failures that escaped uncaught;
  * a goal still shown as reached while the API was down;
  * where the journey stops.

  `recipeChaos()` does the same for any recipe.
* **`--bind`** on crawl, scan and drive serves the browser to other Playwright clients while it runs (`browser.bind`): `npx playwright cli attach <title>`, or an MCP client with `npx playwright mcp --endpoint <endpoint>`. `drive --keep-open` leaves the final page open for one to take over.
* **`--aria-targets`** on crawl and scan joins the accessibility snapshot to the CSS scrape:
  * controls the scrape misses become targets, such as a `<div onclick>` with a pointer cursor, a searchbox, or tabs past the cap;
  * every target is described from the tree (`button "Pay" — in dialog "Checkout"`).
* **AI drivers see the page's structure.** `DriverStep.outline` and the driver prompt carry an accessibility outline of the page, with `[#N]` marking candidate N.
* Library additions: `readAria` / `ariaCandidates` / `ariaOutline`, `watchProblems`, `bindBrowser`.
* `perf.browser` records the browser version. `perf regress` refuses (exit 2) to compare across browser major versions; `--allow-browser-mismatch` overrides.
* `pixelmatch` 8 is accepted as a peer.

### Bug Fixes

* **`scan` false positives from the scanning browser:**
  * A `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` that only the headless browser gets becomes an environment note. eslint.org's ad server answers HeadlessChrome with a 403 and `Cross-Origin-Resource-Policy: same-origin`.
  * An ORB-blocked script or stylesheet that serves fine becomes an environment note too (astro.build's Fathom script).
  * Refused URLs are probed once per path, so per-page ad URLs no longer use up the probe cap.
* **An unhandled rejection is reported on the page it escaped on**, not on the page the crawl visited before a click navigated away.
* `blockedNavigations` was always empty; it now lists the off-site navigations that were blocked.
* `--no-headless` shows the browser again.

## [0.11.2](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.11.1...chaosbringer-v0.11.2) (2026-10-02)

Found by scanning bun.sh, hono.dev, docs.python.org, web.dev, jquery.com and demoblaze.com.

### Bug Fixes

* **One CSP violation is one error cluster again.** The fingerprint now drops the CSP nonce and hash. The nonce changes on every response, and the hash identifies the inline block rather than the violation, so jquery.com's two violations came out as 16 clusters, one per page.
* **`scan` separates ORB blocks that the crawler caused.** Chromium's opaque-response blocking sometimes stops a cross-origin image that is fine, while the page's requests are intercepted. After the crawls, each `net::ERR_BLOCKED_BY_ORB` URL is fetched once directly:
  * a 2xx image, media or font becomes an environment note;
  * anything else stays a finding, for example a 403 with an XML body.

## [0.11.1](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.11.0...chaosbringer-v0.11.1) (2026-10-02)

Found by scanning playwright.dev, vite.dev, htmx.org, tailwindcss.com, developer.mozilla.org and webscraper.io. See [#178](https://github.com/mizchi/chaosbringer/pull/178).

### Bug Fixes

* **An excluded URL is never clicked.** Before this, `excludePatterns` / `--exclude` only kept the crawl from *visiting* a URL as a page, and a "Log out" link was still clicked with `--exclude /logout`. Now:
  * links to excluded URLs are not click targets;
  * when a click or a page load redirects onto an excluded URL, the crawl backs out and records `excludedTo`.
* **Non-HTML documents are not measured.** A same-site URL that serves something other than HTML (an Atom feed, a JSON file) is recorded with its `contentType` and is not measured or clicked: the browser's XML viewer was reported as the site's "Large DOM". A click that opens one goes back and records `openedFile`.
* **The browser's language is always a valid tag.** It is now the host locale. Under a POSIX locale `navigator.language` used to be `en-US@posix`, and a page's `new Intl.Locale(navigator.language)` threw.
* **`scan` no longer breaks page loads as if they were API calls.** Pages the crawled pages link to, and excluded URLs, are no longer chaos targets: a router prefetching linked routes (`?_rsc=`) was failed and reported as a retry storm.
* **`scan` tells revalidations from re-downloads.** A file downloaded once and then revalidated on every page is reported as revalidated (medium), not as "downloaded again" (high).
* **`--ignore-analytics` covers ad pixels too.** It now also ignores doubleclick.net, googleadservices.com and mixpanel.com, as the `analytics` preset already did.

## [0.11.0](https://github.com/mizchi/chaosbringer/compare/96ba95d...chaosbringer-v0.11.0) (2026-10-01)

0.10.0 cannot be imported from npm: it needs exports of `@mizchi/playwright-faults` that were never released. This release depends on `@mizchi/playwright-faults@^0.3.0` and `lightbringer@^0.4.0`, which have them. Upgrade from 0.9.0 straight to 0.11.0.

### Features

* `chaosbringer scan`: sweep an unknown site for bugs, fragile error handling and slow spots, with a ranked report. See [docs/recipes/scan.md](https://github.com/mizchi/chaosbringer/blob/main/docs/recipes/scan.md). ([#169](https://github.com/mizchi/chaosbringer/pull/169))
* Per-step perf measurement: every page load and action is a lightbringer span. ([#150](https://github.com/mizchi/chaosbringer/pull/150))
* Per-step perf budgets for CI, adaptive settle, perf under chaos, and a perf-seeking driver. ([#151](https://github.com/mizchi/chaosbringer/pull/151), [#152](https://github.com/mizchi/chaosbringer/pull/152))
* Page-level perf metrics and the perf-patterns catalog. ([#158](https://github.com/mizchi/chaosbringer/pull/158), [#159](https://github.com/mizchi/chaosbringer/pull/159))
* Preview crawls in terminal-browser tabs. ([#149](https://github.com/mizchi/chaosbringer/pull/149))

### Bug Fixes

* The crawler keeps trailing slashes when it visits a URL. ([#170](https://github.com/mizchi/chaosbringer/pull/170))
* A page or a click that redirects off-site is recorded (`redirectedTo`, `leftSiteTo`), and nothing of the other site is reported. ([#171](https://github.com/mizchi/chaosbringer/pull/171), [#173](https://github.com/mizchi/chaosbringer/pull/173))
* A network fault is tagged on the span its request started in, not on whatever span was open when the route handler heard of it; a click that closed before then lost the tag. ([#175](https://github.com/mizchi/chaosbringer/pull/175))
* The HTTP cache stays on while external navigations are blocked. ([#161](https://github.com/mizchi/chaosbringer/pull/161))
* The same seed gives the same picks in `perfSeekingDriver`, and a fault's cost is measured on steps the settle did not wait for. ([#156](https://github.com/mizchi/chaosbringer/pull/156), [#157](https://github.com/mizchi/chaosbringer/pull/157))

## [0.10.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.9.0...chaosbringer-v0.10.0) (2026-09-23)

### Breaking Changes

* Custom driver providers and advisors must now await `screenshot()` instead of reading a `Buffer`. `AdvisorCandidate.type` is required. ([#145](https://github.com/mizchi/chaosbringer/pull/145))

### Features

* Expose candidate geometry and obstruction information to drivers, providers, and advisors, with screenshots captured on demand. (#143, #145)
* Let drivers select dropdown values and empty selected fields. (#146, #147)
* Add model-driven Promise fault coverage, deterministic replay, and failing fault-plan shrinking. (#135, #137)
* Detect shadowed fault rules at crawl start. (#133)

### Bug Fixes

* Interact with form fields using values accepted by each field type, and refresh driver candidates before every step. (#140, #141, #142)
* Report unavailable checks and run-end fault warnings across all fault layers. (#136, #138)
* Address crawler configuration and diagnostic usability gaps. (#131)

## [0.9.0](https://github.com/mizchi/chaosbringer/compare/chaosbringer-v0.8.1...chaosbringer-v0.9.0) (2026-05-15)


### Features

* AI-driven recipe layer + scenarioLoad + OWASP auth attacks ([#97](https://github.com/mizchi/chaosbringer/issues/97)) ([72ce951](https://github.com/mizchi/chaosbringer/commit/72ce95107097d4f44cdcc7842a4f54091e3a92e0))
* CLI surface — recipes diff/lint/repair + `chaosbringer load` ([#98](https://github.com/mizchi/chaosbringer/issues/98)) ([99a48c0](https://github.com/mizchi/chaosbringer/commit/99a48c00b1bb0fe6f2b06f7e9aa20c1c4b3d2ed7))
* parity N-sample perf + playground CI gate + sibling `--output` mkdir fixes ([#105](https://github.com/mizchi/chaosbringer/issues/105)) ([8b57adf](https://github.com/mizchi/chaosbringer/commit/8b57adf327397a4cbf8baa35f3807b6365ed73f3))
* close out remaining open issues ([#80](https://github.com/mizchi/chaosbringer/issues/80), [#81](https://github.com/mizchi/chaosbringer/issues/81), [#82](https://github.com/mizchi/chaosbringer/issues/82), [#83](https://github.com/mizchi/chaosbringer/issues/83), [#87](https://github.com/mizchi/chaosbringer/issues/87), [#88](https://github.com/mizchi/chaosbringer/issues/88)) + test coverage ([#99](https://github.com/mizchi/chaosbringer/issues/99)) ([a38a7fc](https://github.com/mizchi/chaosbringer/commit/a38a7fc26e84bbedab2da55e29c95c4937c5d4f5))
* dogfood playground + 11 iterations of agent-driven parity/journey improvements ([#101](https://github.com/mizchi/chaosbringer/issues/101)) ([521078e](https://github.com/mizchi/chaosbringer/commit/521078edb98b6d56e9f9a7d09efc4bd5e9d1aaa7))


### Bug Fixes

* **cluster-artifacts:** strip `|` from cluster bundle dirnames so `actions/upload-artifact@v4` (which rejects `" : < > | * ? \r \n`) no longer kills CI jobs even when every assertion inside them passed ([#106](https://github.com/mizchi/chaosbringer/issues/106)) ([2bc9133](https://github.com/mizchi/chaosbringer/commit/2bc9133e4703a04d263cf8b2fb24347390d65dec))

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
