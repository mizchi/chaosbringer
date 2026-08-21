#!/usr/bin/env bash
# Compile this model's witnesses into plans.
#
# The unit owns its own compile options so CI does not have to know them; this
# model needs none beyond the defaults. TRACES / OUT are overridable so a drift
# check can compile into a scratch directory without touching the committed
# plans.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}"
