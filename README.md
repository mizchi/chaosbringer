# chaosbringer

Chaos testing toolkit for web apps. A Playwright-based crawler injects faults at every layer a browser test can reach — network, page lifecycle, JS runtime — and a sibling `@mizchi/server-faults` covers the layer the browser cannot reach: inside the server process. Same `traceparent`, one report.

## Where each package fits

`chaosbringer` only injects faults that a **browser-driven** test can reach. Server-internal failure modes need a sibling library. Pick the layer before reaching for a fault provider:

| Layer | Library | What it touches | When to use |
|---|---|---|---|
| **Application state** | `chaos({ setup })` hook | Backend rows, storage state, fixtures (via Playwright `page.request`) | "Crawler needs N todos to navigate" |
| **Network** | [`chaosbringer`](packages/chaosbringer) `faults.*` | HTTP between browser and server (Playwright `route()`) | "What does the UI do when `/api/x` is 500 / slow / aborted" |
| **Page lifecycle / runtime** | [`chaosbringer`](packages/chaosbringer) `lifecycleFaults` / `runtimeFaults` | Browser DOM, storage wipe, CPU throttle, `fetch` / clock monkey-patches | "Does the SPA recover when localStorage gets wiped mid-action" |
| **Server-side** | [`@mizchi/server-faults`](packages/server-faults) | Inside the server process, before the handler runs | "Do the server's OTel traces / metrics show the fault, and does the handler degrade gracefully" |
| **Cloudflare bindings** | [`@mizchi/cf-faults`](packages/cf-faults) | KV / Service Binding wrappers | "How does the Worker behave when its KV throws" |

**Common confusion:** `faults.status(500, …)` from chaosbringer **does not produce server-side telemetry** — the route is intercepted in the browser, the server is never called. To see a fault inside the server's OTel trace, mount `@mizchi/server-faults` *and* run both layers together. See [`docs/recipes/server-side-correlation.md`](docs/recipes/server-side-correlation.md).

## Packages

| Package | What it is |
|---|---|
| [`chaosbringer`](packages/chaosbringer) | Playwright-based chaos crawler — CLI + library |
| [`@mizchi/server-faults`](packages/server-faults) | Framework-agnostic server-side fault injection (5xx + latency) for Web Standard `Request`/`Response`. Adapters for hono / express / fastify / koa. |
| [`@mizchi/playwright-faults`](packages/playwright-faults) | Playwright fault-injection primitives (network route, page lifecycle, JS runtime monkey-patch) — extracted from chaosbringer for direct Playwright Test use |
| [`@mizchi/playwright-v8-coverage`](packages/playwright-v8-coverage) | V8 precise-coverage collector for Playwright (CDP `Profiler.takePreciseCoverage`) with novelty-scoring helpers |
| [`@mizchi/cf-faults`](packages/cf-faults) | Cloudflare Worker binding wrappers (KV / Service Binding) for chaos injection |

## 30-second tour

```bash
pnpm add chaosbringer playwright @playwright/test
npx playwright install chromium

# crawl localhost, exit 0/1 on errors, print a Repro: line you can paste into CI
chaosbringer --url http://localhost:3000 --max-pages 20 --strict
```

```ts
// or programmatically — fault injection + invariants in 15 lines
import { chaos, faults } from "chaosbringer";

const { passed, report } = await chaos({
  baseUrl: "http://localhost:3000",
  seed: 42,
  faultInjection: [
    faults.status(500, { urlPattern: /\/api\//, probability: 0.3 }),
    faults.delay(2000, { urlPattern: /\/api\//, probability: 0.1 }),
  ],
  invariants: [
    { name: "has-h1", when: "afterLoad", check: async ({ page }) =>
        (await page.locator("h1").count()) > 0 || "missing <h1>" },
  ],
});

console.log(report.reproCommand); // chaosbringer --url … --seed 42 …
process.exit(passed ? 0 : 1);
```

The full feature list, CLI reference, and report-shape walkthrough live in [`packages/chaosbringer/README.md`](packages/chaosbringer/README.md).

## Cookbook — "I want to…"

Task-oriented snippets, ~30-60 lines each, indexed by what you're trying to do:

- [`docs/cookbook/`](docs/cookbook/) — index of all recipes. Highlights:
  - [Fail CI on latency / error regression](docs/cookbook/ci-slo-gating.md) (`assertSlo`)
  - [Wire chaos into GitHub Actions](docs/cookbook/github-actions.md)
  - [Read cause-and-effect from the fault timeline](docs/cookbook/chaos-under-load.md)
  - [Ramp fault probability to find the breaking point](docs/cookbook/probability-ramp.md)
  - [Multiple per-worker logged-in identities](docs/cookbook/per-worker-auth.md)
  - [Standard invariants toolkit](docs/cookbook/invariant-toolkit.md) (toast / state-machine / response shape / monotonic)
  - [Which fault layer for which bug](docs/cookbook/fault-layer-cheatsheet.md)
  - [Find out what actually broke](docs/cookbook/debugging-failures.md) (errors → artifacts → HAR replay)
  - [Realistic think-time shaping](docs/cookbook/think-time-shaping.md)
  - [Grow an AI skill library (Goals + Recipes)](docs/cookbook/ai-recipe-skills.md) — `recipeDriver` replays verified trajectories without LLM calls. See [`examples/recipe-skills/`](examples/recipe-skills/README.md).
  - [The AI ↔ Recipe flywheel](docs/cookbook/ai-flywheel.md) — full A→B→C→D loop: AI discovers, verifier promotes, production replays cheaply under chaos, `investigate()` turns failures into regression recipes.
  - [Attack login / signup forms (OWASP-aligned)](docs/cookbook/auth-attack-driver.md) — `authAttackDriver` runs weak-password, username-enumeration, SQLi, XSS, and rate-limit checks against detected auth forms.
  - [Concepts borrowed from browser-harness + WebMCP](docs/cookbook/browser-harness-concepts.md) — `loadPageScenarios` (app self-declares scenarios), markdown skill seeds, domain-scoped recipe lookup, per-step screenshots, coordinate-fallback clicks, `repairRecipe` for surviving UI drift.

## Recipes — feature explanations

Longer-form "what does this feature do and why" docs:

- [`docs/recipes/drivers.md`](docs/recipes/drivers.md) — Pluggable action-selection strategies (AI-per-step, form-aware, pentest payloads, scripted journeys, parallel shards).
- [`docs/recipes/scenario-load.md`](docs/recipes/scenario-load.md) — Light load (10 workers × 5min) running scripted user journeys, optionally under chaos. Latency p50/p95/p99 per step + per endpoint + per-second timeline. See [`examples/load-with-chaos/`](examples/load-with-chaos/README.md) for a runnable demo.
- [`docs/recipes/seeding-data.md`](docs/recipes/seeding-data.md) — How to seed backend state before a chaos run, including the gotcha where seed `POST`s get eaten by the chaos middleware itself.
- [`docs/recipes/server-side-correlation.md`](docs/recipes/server-side-correlation.md) — Wire chaosbringer + `@mizchi/server-faults` so server-side fault events join chaosbringer's report by W3C `traceparent`.

## Examples

Runnable demos under [`examples/`](examples/), workspace-linked to the local packages so changes flow through immediately. CI runs them end-to-end on every PR (`example-tests` matrix in `.github/workflows/ci.yml`):

- **[`examples/cloudflare-worker/`](examples/cloudflare-worker/)** — Hono on Cloudflare Worker (via `wrangler dev`) + `@mizchi/server-faults` (with `metadataHeader: true` + `bypassHeader`) + chaosbringer driver (with `server: { mode: "remote" }`). Boots both processes and demonstrates the orchestration shipped in the recipes above.
- **[`examples/playwright-test/`](examples/playwright-test/)** — chaosbringer inside an `@playwright/test` suite via the `chaos` fixture. Both `chaosTest` and `withChaos()` extension patterns in one file.
- **[`examples/load-with-chaos/`](examples/load-with-chaos/)** — `scenarioLoad` running 5 virtual users through a shopping journey while 10% of `/api/*` is forced to 500. Boots its own in-process HTTP server. Shows per-step latency rollups, the per-second timeline sparkline, and fault-rule injection stats co-existing in one report.
- **[`examples/recipe-skills/`](examples/recipe-skills/)** — Recipe layer demo: hand-written `ActionRecipe` → `verifyAndPromote` across 3 fresh contexts → re-load store from disk → drive the verified recipe through `recipeDriver`. Self-contained, no API key.

## Internal design docs

- `docs/superpowers/specs/` — design specs for non-trivial features (kept under version control so the *why* survives the *what*).
- `docs/superpowers/plans/` — implementation plans corresponding to specs.

These are internal; users do not need to read them. They exist to keep design rationale next to the code.

## Development

```bash
pnpm install
pnpm -F chaosbringer build
pnpm -F chaosbringer test
```

`pnpm -r <script>` runs across every package; `pnpm -F <name> <script>` targets one. Workspace metadata lives in `pnpm-workspace.yaml`.

## Layout

```
chaosbringer/
├── packages/
│   ├── chaosbringer/             # the npm `chaosbringer` package
│   ├── server-faults/            # `@mizchi/server-faults`
│   ├── playwright-faults/        # `@mizchi/playwright-faults`
│   ├── playwright-v8-coverage/   # `@mizchi/playwright-v8-coverage`
│   └── cf-faults/                # `@mizchi/cf-faults`
├── examples/                     # runnable demos (workspace-linked to packages/*)
├── docs/
│   ├── recipes/                  # task-oriented user docs
│   └── superpowers/              # design specs + plans (internal)
├── package.json                  # workspace root (private, not published)
└── pnpm-workspace.yaml
```

## License

MIT
