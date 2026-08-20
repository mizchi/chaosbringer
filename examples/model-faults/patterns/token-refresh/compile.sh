#!/usr/bin/env bash
# Compile this pattern's witnesses into plans. `--state-var refreshes` is what
# makes the stampede observable.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var refreshes \
  --ignore-action refresh
