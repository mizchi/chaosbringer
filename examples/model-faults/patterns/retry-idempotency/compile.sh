#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# The pattern owns its own compile options — `--state-var orders` is what makes
# the double-write observable — so CI does not have to know them.
# TRACES / OUT are overridable so a drift check can compile into a scratch dir.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var orders
