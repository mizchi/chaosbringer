# Operating the recipe store from the command line

The `chaosbringer recipes` subcommand is the operator surface on top of
the recipe layer. Use it for inventory, review, gating, and ad-hoc
repairs without writing TypeScript.

## Inventory + review

```sh
# What's in the store?
pnpm chaosbringer recipes list

# Filter by status / domain / goal
pnpm chaosbringer recipes list --status verified --domain example.com

# Inspect one recipe
pnpm chaosbringer recipes show shop/checkout

# Inspect a historical version
pnpm chaosbringer recipes show shop/checkout --version 3

# See the version timeline
pnpm chaosbringer recipes history shop/checkout
```

## Diffing versions and recipes

`recipes diff` runs a Myers LCS over the step list and reports tracked
field changes (status / origin / preconditions / postconditions /
requires). Defaults: `--from-version` = newest archived, `--to-version`
= current.

```sh
# Default: diff current vs. previous version
pnpm chaosbringer recipes diff shop/checkout

# Compare two specific versions
pnpm chaosbringer recipes diff shop/checkout --from-version 2 --to-version 5

# Compare two different recipes
pnpm chaosbringer recipes diff shop/checkout..shop/checkout-fast

# JSON for scripting
pnpm chaosbringer recipes diff shop/checkout --json
```

The colour output activates automatically in a TTY. Force it with
`--color`; suppress with `--quiet --json`.

## Linting

`recipes lint` runs static checks on a recipe (or every recipe) without
touching a browser. Useful as a pre-commit hook or CI gate after the AI
flywheel writes new recipes.

```sh
# Lint a single recipe
pnpm chaosbringer recipes lint shop/checkout

# Lint everything in the store
pnpm chaosbringer recipes lint

# Strict: warnings become exit 1 (good for CI)
pnpm chaosbringer recipes lint --strict
```

Rules currently enforced:

| Rule | Severity | What it catches |
|---|---|---|
| `empty-steps` | error | recipe has zero steps |
| `verified-without-postconditions` | error | `status: "verified"` but nothing to assert against |
| `click-at-without-viewport-hint` | error | coordinate click can't be replay-validated |
| `missing-required-recipe` | error | `requires` points at a recipe not in the store |
| `requires-cycle` | error | dependency cycle detected |
| `empty-preconditions` | warn | recipe is eligible everywhere |
| `missing-expect-after` | warn | click/fill/select with no post-step assertion |
| `long-raw-wait` | warn | `wait.ms` ≥ 2000ms (prefer `waitFor`) |
| `hardcoded-credentials` | warn | password-looking field with a non-templated value |
| `adjacent-duplicate-wait` | info | two `wait` steps in a row |

## Auto-repair (CLI form)

`recipes repair` uses the **weighted-random** driver — free, deterministic
with `--seed`, no API key required. For LLM-driven repair, call
`repairRecipe()` programmatically with an AI driver (see
[`docs/cookbook/browser-harness-concepts.md`](./browser-harness-concepts.md)).

```sh
pnpm chaosbringer recipes repair shop/checkout \
  --base-url http://localhost:3000 \
  --repair-budget 20 --seed 42
```

On success the patched recipe is upserted under a fresh version (the old
one moves to history — you can always `recipes rollback --to-version N`).

## Replaying the whole store as load

`chaosbringer load` (no `recipes` prefix) replays verified recipes from
the store under N concurrent workers. Pairs with `scenarioLoad` for
the chaos / SLO / fault-injection knobs.

```sh
# 5 workers, 60s, uniform selection over verified recipes
pnpm chaosbringer load --base-url http://localhost:3000

# 20 workers for 3 minutes, ramp linearly over the first 30s,
# pick recipes weighted by historical success rate
pnpm chaosbringer load \
  --base-url http://localhost:3000 \
  --workers 20 --duration 3m --ramp-up 30s \
  --selection by-success-rate

# Use the global store, write the JSON report for diff against a baseline
pnpm chaosbringer load --global \
  --base-url http://localhost:3000 \
  --output load-report.json
```

Exit code is 1 on any iteration / step failure — wire it straight into CI.

For fault injection or SLO assertions, drop to the programmatic
`scenarioLoadFromStore()` API (see [`load-from-recipe-store.md`](./load-from-recipe-store.md)).
