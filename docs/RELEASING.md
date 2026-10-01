# Releasing chaosbringer + Layer-1 packages

This monorepo ships **four** npm packages from one git repo. Each has its own version, lockstep is **not** required. Some have ordering constraints (chaosbringer's deps must publish first).

| Package | npm name | Source | Status |
|---|---|---|---|
| Crawler CLI / library | `chaosbringer` | `packages/chaosbringer/` | Published; release-please-managed |
| Server-side fault injection | `@mizchi/server-faults` | `packages/server-faults/` | Awaiting first publish (manual OIDC bootstrap) |
| V8 coverage primitives | `@mizchi/playwright-v8-coverage` | `packages/playwright-v8-coverage/` | Awaiting first publish (manual OIDC bootstrap) |
| Network/lifecycle/runtime fault primitives | `@mizchi/playwright-faults` | `packages/playwright-faults/` | Awaiting first publish (manual OIDC bootstrap) |

## TL;DR — release the dependencies first

`chaosbringer` declares `workspace:^` dependencies on `@mizchi/playwright-faults`, `@mizchi/playwright-v8-coverage` and `lightbringer`. At publish time pnpm rewrites each one to the version **in that package's package.json**, and a consumer then gets that version **from npm**. In the workspace the dependency is the source tree, so local CI cannot tell when the two differ.

They differed in chaosbringer@0.10.0. It imported `buildDecisionHelperSource`, which playwright-faults gained after 0.2.0. playwright-faults was never released again, so 0.10.0 depended on `^0.2.0` and failed at `import "chaosbringer"` with "does not provide an export named …". Downstream users had to pin 0.9.0.

So a release goes in dependency order:

1. `@mizchi/playwright-faults`, `@mizchi/playwright-v8-coverage`, `lightbringer`: merge their release PRs first. Each one needs a release whenever its shipped source changed since its last tag, even if only chaosbringer uses the change.
2. `chaosbringer`, after those versions are on npm.

`publish.yml` enforces this. Before publishing it runs `scripts/check-publish-deps.mjs <package dir>`, which refuses the publish when:

- a workspace dependency's current version is not on npm. It waits up to 10 minutes first, for a dependency released in the same batch.
- a workspace dependency's shipped files changed since the tag of its current version (`<dir>-v<version>`). For a version with no tag in this repo (lightbringer 0.3.1 was released from its old repository), it compares the tarball npm serves with what the tree packs instead.
- the package, packed as `pnpm publish` packs it and installed into an empty directory from npm, fails to import any of its `exports` entries.

Run it locally before cutting a release (after `pnpm -r build`):

```bash
pnpm check:publish packages/chaosbringer
```

A refused publish is recovered by releasing the dependency it names, then re-running publish.yml with `workflow_dispatch` and `package_dir: chaosbringer`.

## Step 1 — bootstrap OIDC trusted publishing for new packages (one-time, mizchi)

The CI `publish.yml` uses OIDC ("Trusted Publishing") to publish without any long-lived npm token. For each NEW package's first publish, npm requires the package to exist on the registry **before** OIDC can authenticate. Bootstrap by publishing manually once:

```bash
cd packages/server-faults
npm publish --access public          # asks for 2FA OTP

cd ../playwright-v8-coverage
npm publish --access public

cd ../playwright-faults
npm publish --access public
```

`--provenance` is intentionally omitted: provenance generation requires a CI environment (GitHub Actions OIDC). For the manual bootstrap, plain publish is fine.

After each first publish, configure the **Trusted Publisher** on npmjs.com:

1. https://www.npmjs.com/package/@mizchi/server-faults/access (and equivalent for the other two)
2. "Trusted Publisher" → "Add Publisher" → GitHub Actions
3. Repository: `mizchi/chaosbringer`
4. Workflow filename: `publish.yml`
5. Environment: leave blank (this repo doesn't use deployment environments)

Once configured, all subsequent publishes from CI succeed with `--provenance`.

## Step 2 — release flow for chaosbringer (release-please)

Currently configured in `release-please-config.json` and `.release-please-manifest.json`.

```
git push  # commits with feat:/fix:/perf: prefixes
↓
release-please.yml workflow_dispatch (or auto on PR merge to main of release-please-- branches)
↓
release-please-action opens a "chore(main): release chaosbringer X.Y.Z" PR
↓
merge that PR
↓
release-please.yml fires AGAIN on the merge (head.ref starts with release-please--)
↓
release-please creates tag chaosbringer-v<X.Y.Z> + GitHub Release
↓
publish.yml triggers on `release: published`
↓
npm publish (OIDC, with provenance)
```

**Caveat from this repo's history:** when the workspace migration in #42 changed the package's path mid-release-cycle, release-please's path-based commit matching skipped the in-flight feat: commits. Resolution was a manual 0.6.0 release (one commit bumping version + CHANGELOG, then tag + GH Release manually). After the workspace-relative paths stabilized in main, release-please resumed working correctly for 0.7.0 (#49).

## Step 3 — release flow for the new Layer-1 packages

Currently NOT in release-please. Two options going forward:

### Option A: keep them manually-versioned (low overhead, 1-2 releases/year)

Bump version in the package's `package.json`, update `CHANGELOG.md` if any, then `cd packages/<x> && npm publish --access public --provenance` (the provenance flag works in CI; for local-from-laptop manual publish, drop `--provenance`).

### Option B: extend release-please-config.json to manage them

Adds entries like:

```json
"packages": {
  "packages/chaosbringer": { "package-name": "chaosbringer", "changelog-path": "CHANGELOG.md" },
  "packages/playwright-faults": { "package-name": "@mizchi/playwright-faults", "changelog-path": "CHANGELOG.md" },
  ...
}
```

release-please will then open a PR per package that has unreleased feat:/fix: commits. Each PR's merge tags `<name>-v<ver>` and `publish.yml` (after the multi-package update below) publishes that one.

Option B is cleaner long-term but adds CI surface. Defer until release frequency justifies it.

## Step 4 — multi-package publish.yml

`publish.yml` currently hardcodes `packages/chaosbringer` as the publish target. To support all 4 packages it must derive the target from the release tag.

Tag format conventions:
- `chaosbringer-v<ver>` (release-please monorepo style) → `packages/chaosbringer`
- `v<ver>` (legacy chaosbringer-only, used through 0.6.0) → `packages/chaosbringer`
- `<short-name>-v<ver>` for scoped packages (release-please drops the scope prefix in the tag) → `packages/<short-name>`

Reference `publish.yml` skeleton (see this PR for the actual implementation):

```yaml
- name: Determine target package directory
  id: pkg
  env:
    TAG: ${{ github.event.release.tag_name }}
  run: |
    if [[ "$TAG" =~ ^([a-z0-9-]+)-v[0-9] ]]; then
      echo "dir=packages/${BASH_REMATCH[1]}" >> "$GITHUB_OUTPUT"
    else
      echo "dir=packages/chaosbringer" >> "$GITHUB_OUTPUT"   # legacy v<ver> tag
    fi
- run: pnpm -r build
- working-directory: ${{ steps.pkg.outputs.dir }}
  run: npm publish --access public --provenance
```

## Anti-checklist (mistakes from this repo's history)

- **Don't release `chaosbringer` while a dependency has unreleased changes.** The published tarball will be broken even though local CI passes (chaosbringer@0.10.0). `check-publish-deps.mjs` refuses it; don't work around it with a manual `npm publish`.
- **Don't trigger `release-please.yml` immediately after a workspace-path migration.** Path-based commit matching may skip in-flight `feat:` commits. Either wait for a clean post-migration cycle or do a manual release for the transitional version (chaosbringer's 0.6.0 in this repo).
- **Don't add `--provenance` to local manual publishes.** It requires CI OIDC and fails locally with `Automatic provenance generation not supported for provider: null`.
- **Don't forget to add `prepare: tsc` to a new workspace package** that other workspace packages depend on. Without it, the dependent's prepare runs on fresh install before the dep is built and tsc fails with `Cannot find module @mizchi/<x>`.
