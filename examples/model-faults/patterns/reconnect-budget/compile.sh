#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# `--calls-var stream=attempts` is the whole pattern: the bound lives in the
# number of requests, not in anything on screen. There is no --state-var here
# because there is no state to read — a client with a budget and one without
# render the same spinner and the same connection.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --calls-var stream=attempts
