#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# `--state-var items` is the model's quantitative claim; the ordering claim is
# not here on purpose — it lives in the bridge's uiInvariants, because "the rows
# are in ascending order" is a rule about this app's DOM rather than a state the
# model should enumerate.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var items
