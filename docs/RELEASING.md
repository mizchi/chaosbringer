# Releasing

This monorepo publishes six npm packages, each with its own version:

| npm name | Source |
|---|---|
| `chaosbringer` | `packages/chaosbringer/` |
| `lightbringer` | `packages/lightbringer/` |
| `@mizchi/playwright-faults` | `packages/playwright-faults/` |
| `@mizchi/playwright-v8-coverage` | `packages/playwright-v8-coverage/` |
| `@mizchi/server-faults` | `packages/server-faults/` |
| `@mizchi/cf-faults` | `packages/cf-faults/` |

They are published by `.github/workflows/publish.yml` with npm OIDC
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers): no npm token
is stored anywhere, and every version carries provenance.

## Cutting a release

1. In a PR, raise `version` in the package.json of each package to release,
   and add the entry to its `CHANGELOG.md`:

   ```bash
   cd packages/playwright-faults && npm version minor --no-git-tag-version
   ```

   Release a dependency whenever its shipped source changed, even when only
   chaosbringer uses the change (see below).
2. Merge it to main. `publish.yml` runs on any push to main that changes a
   `packages/*/package.json`. It:
   - lists the packages whose version is not on npm yet, dependencies before
     the packages that use them (`scripts/pending-publishes.mjs`);
   - for each one, runs `scripts/check-publish-deps.mjs`, publishes it with
     `pnpm publish --provenance`, and pushes the tag `<dir>-v<version>`
     (`playwright-faults-v0.3.0`).

   A push that changes a package.json without changing a version publishes
   nothing.
3. If a publish was refused or failed, fix the cause and run `publish.yml`
   from the Actions tab (`workflow_dispatch`). It picks up whatever is still
   missing from npm.

Check a release before merging it (after `pnpm -r build`):

```bash
pnpm check:publish packages/chaosbringer
```

## Why dependencies go first

`chaosbringer` declares `workspace:^` dependencies on `@mizchi/playwright-faults`,
`@mizchi/playwright-v8-coverage` and `lightbringer`. At publish time pnpm
rewrites each one to the version **in that package's package.json**, and a
consumer then gets that version **from npm**. In the workspace the dependency
is the source tree, so local CI cannot tell when the two differ.

They differed in chaosbringer@0.10.0. It imported `buildDecisionHelperSource`,
which playwright-faults gained after 0.2.0. playwright-faults was never
released again, so 0.10.0 depended on `^0.2.0` and failed at
`import "chaosbringer"` with "does not provide an export named …".

`check-publish-deps.mjs` refuses to publish a package when:

- a workspace dependency's current version is not on npm;
- a workspace dependency's shipped files changed since the tag of its current
  version. For a version with no tag in this repo (lightbringer 0.3.1 was
  released from its old repository), it compares the tarball npm serves with
  what the tree packs instead;
- the package, packed as `pnpm publish` packs it and installed into an empty
  directory from npm with its peers, fails to import any of its `exports`
  entries.

Because `publish.yml` publishes in dependency order in one run, bumping a
dependency and chaosbringer in the same PR works: the dependency is on npm and
tagged before chaosbringer is checked.

## Trusted Publisher setup (once per package)

On npmjs.com, each package's **Settings → Trusted Publisher** must name
GitHub Actions, repository `mizchi/chaosbringer`, workflow `publish.yml`, no
environment. A new package has to exist on npm before it can be configured,
so publish its first version by hand (`npm publish --access public`, without
`--provenance`, which needs CI), then configure it.

`lightbringer` was published from `mizchi/lightbringer` until it moved here.
Point its Trusted Publisher at this repository before its next release.

## Anti-checklist (mistakes from this repo's history)

- **Don't release `chaosbringer` while a dependency has unreleased changes.**
  The published tarball will be broken even though local CI passes
  (chaosbringer@0.10.0). `check-publish-deps.mjs` refuses it; don't work
  around it with a manual `npm publish`.
- **Don't use `npm publish` for a package with `workspace:` dependencies.** It
  leaves `workspace:^` in the published package.json (chaosbringer@0.8.0).
- **Don't rename `publish.yml`.** The Trusted Publisher configuration names
  the file; a renamed workflow cannot publish.
- **Don't add `--provenance` to a manual publish.** It requires CI OIDC and
  fails locally with `Automatic provenance generation not supported for
  provider: null`.
- **Don't forget `prepare: tsc` in a new workspace package** that other
  workspace packages depend on. Without it, the dependent's prepare runs on a
  fresh install before the dependency is built, and tsc fails with
  `Cannot find module @mizchi/<x>`.
