# chaosbringer cookbook

Task-oriented snippets. Find the *thing you want to do* in the table below and copy the linked recipe — each one is ~30-60 lines and runnable after you swap in your `baseUrl`.

The three doc surfaces:

| When you want to… | Look at |
|---|---|
| Understand what a feature *is* and *why* it exists | [`docs/recipes/`](../recipes/) (feature explanation) |
| Copy a small snippet for a specific task | **here (`docs/cookbook/`)** |
| See a full working app with `package.json` | [`examples/`](../../examples/) |

## Index — "I want to…"

### CI + gating

- **[Fail CI on latency / error regression](./ci-slo-gating.md)** — `assertSlo` on `LoadReport` with p95/error-rate/throughput thresholds.
- **[Wire chaos into GitHub Actions](./github-actions.md)** — Minimal workflow that boots a server, runs load + chaos, fails on SLO breach, uploads artifacts.

### Combining chaos with load

- **[Read cause-and-effect from the fault timeline](./chaos-under-load.md)** — Run `scenarioLoad` with `faultInjection`, then read the `fault:*` sparkline rows lined up with the `errors` row.
- **[Ramp fault probability to find the breaking point](./probability-ramp.md)** — Loop `scenarioLoad` calls with `probability` increasing per run; bisect on first SLO breach.

### Real-user simulation

- **[Multiple per-worker logged-in identities](./per-worker-auth.md)** — `storageState` as a factory; reset between iterations.
- **[Realistic think-time shaping](./think-time-shaping.md)** — uniform vs. gaussian vs. none, plus step-level overrides.

### AI-driven exploration

- **[Grow an AI skill library (Goals + Recipes)](./ai-recipe-skills.md)** — `recipeDriver` replays verified trajectories without LLM calls; `Goal` defines the persona (normal user / bug hunter / coverage explorer) the AI operates as.
- **[The AI ↔ Recipe flywheel](./ai-flywheel.md)** — full A→B→C→D loop: AI discovers (`tracingDriver`), verifier promotes (`verifyAndPromote`), production replays cheaply under chaos (`recipeDriver` + faults), and `investigate()` turns failures back into regression recipes.
- **[Concepts borrowed from browser-harness + WebMCP](./browser-harness-concepts.md)** — `loadPageScenarios` (app self-declares its testable scenarios), `parseSkillMarkdown` (prose seeds), `RecipeStore.byDomain` (multi-host libraries), `repairRecipe` (AI patches recipe drift), per-step screenshots, coordinate-fallback clicks.
- **[Recipe composition + delta-debugged regressions](./recipe-composition.md)** — `requires` now chains (auto-resolves login before checkout), `investigate({ minimize: true })` shrinks reproduction traces to the 1-minimal subset.
- **[Load-test your whole recipe library](./load-from-recipe-store.md)** — `scenarioLoadFromStore` + recipe templating (`{{email}}`) drives N workers through verified recipes with per-iteration variables. Connects the recipe library to scenarioLoad + chaos in one call.
- **[Production-safe recipe runs](./production-safety.md)** — storage-state snapshots cut the `requires` chain cost (issue #89), version history + rollback let you undo a bad `repairRecipe` (issue #90).
- **[Use recipes inside @playwright/test](./playwright-test-recipes.md)** — `recipesTest` / `withRecipes()` fixture: `runRecipe`, `harvestPageScenarios`, `investigate` inside a normal PW Test suite (issue #91).

### Security testing

- **[Attack login / signup forms (OWASP-aligned)](./auth-attack-driver.md)** — `authAttackDriver` detects auth forms and runs five attack scenarios: weak-password acceptance, username enumeration, SQLi auth-bypass, reflected XSS, missing rate limiting. Findings carry OWASP / NIST references.

### Invariants (what counts as "broken")

- **[Standard invariants toolkit](./invariant-toolkit.md)** — no-error-toast, state-machine, response-shape, monotonic-counter. Copy-paste shapes.

### Fault design

- **[Which fault layer for which bug](./fault-layer-cheatsheet.md)** — Decision table: `faults.*` (network) vs `runtimeFaults` (in-page JS) vs `lifecycleFaults` (page stage) vs `@mizchi/server-faults` (inside the server).

### Debugging

- **[Find out what actually broke](./debugging-failures.md)** — `report.errors` first, then `failureArtifacts` (HTML+screenshot+trace), then HAR replay to reproduce without the SUT.

## Conventions in the recipes

- Every snippet uses `baseUrl: "http://localhost:3000"` — replace with yours.
- Imports are explicit so you can paste into a fresh file. Every import comes from the `chaosbringer` package; no internal paths.
- "30 lines or so" is the budget. If a recipe outgrows that, it gets split.
- Each recipe links **back** to the relevant feature doc in `docs/recipes/` if you want depth.
