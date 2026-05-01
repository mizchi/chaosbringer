# chaosbringer monorepo

This repository hosts `chaosbringer` plus future Layer-1 packages extracted from it.

## Packages

- [`chaosbringer`](packages/chaosbringer) — Playwright-based chaos testing CLI + library
- [`@mizchi/playwright-faults`](packages/playwright-faults) — Playwright fault-injection primitives (network route, page lifecycle, JS runtime monkey-patch)
- [`@mizchi/playwright-v8-coverage`](packages/playwright-v8-coverage) — V8 precise-coverage collector for Playwright (CDP `Profiler.takePreciseCoverage`) with novelty-scoring helpers
- [`@mizchi/server-faults`](packages/server-faults) — framework-agnostic server-side fault injection (5xx + latency) for Web Standard Request / Response

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
