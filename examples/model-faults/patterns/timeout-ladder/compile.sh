#!/usr/bin/env bash
# Compile this pattern's witnesses into plans. No state vars: everything this
# pattern asserts is visible in the UI, which is unusual for these patterns.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile --traces "${TRACES:-traces}" --out "${OUT:-plans}"
