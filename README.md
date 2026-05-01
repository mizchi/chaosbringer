# chaosbringer monorepo

This repository hosts `chaosbringer` plus future Layer-1 packages extracted from it.

## Packages

- [`chaosbringer`](packages/chaosbringer) — Playwright-based chaos testing CLI + library

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
│   └── chaosbringer/      # the npm `chaosbringer` package
│       ├── flaker.toml    # package-local @mizchi/flaker config
│       └── .flaker/       # storage (gitignored, persisted across CI runs via actions/cache)
├── docs/                  # repo-wide design notes (see docs/superpowers/specs/)
├── package.json           # workspace catalog (private, not published)
└── pnpm-workspace.yaml
```
