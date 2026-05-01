# chaosbringer monorepo — `just <recipe>` shortcuts.
# Recipes are workspace-aware: `just build` / `just test` etc. operate on every package
# via `pnpm -r`. Use `just <pkg> <recipe>` to scope to one package, e.g. `just chaosbringer test`.

set shell := ["bash", "-c"]
set positional-arguments

default:
    @just --list

# install deps for the whole workspace
install:
    pnpm install --frozen-lockfile

# build every package in topological order
build:
    pnpm -r build

# run every package's vitest suite (chaosbringer's includes the Playwright fixture e2e)
test:
    pnpm -r test

# fail the build when any source file contains a NUL byte (background: see scripts/check-no-nul.mjs)
lint-nul:
    pnpm -r lint:nul

# remove dist + node_modules across the workspace
clean:
    rm -rf packages/*/dist packages/*/node_modules node_modules

# run a script within one package: `just pkg chaosbringer build`
pkg name *args:
    pnpm -F {{name}} {{args}}

# run the fixture site standalone (chaosbringer dev loop)
fixture-serve:
    pnpm -F chaosbringer fixture:serve

# crawl the local fixture (assumes fixture-serve is running on PORT=4173)
fixture-crawl:
    pnpm -F chaosbringer fixture:run

# release ops — see docs/RELEASING.md for the full procedure
release-please:
    gh workflow run release-please.yml --ref main

# manual publish for the FIRST release of a new package (OIDC bootstrap; no --provenance from local)
publish-bootstrap pkg:
    cd packages/{{pkg}} && npm publish --access public
