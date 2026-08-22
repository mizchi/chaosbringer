#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# Two observables the UI cannot report on its own:
#   --state-var  committed / shown, compared against the bridge's stateProbe.
#   --calls-var  listCalls, compared against the requests the fault layers saw.
# The second is what judges `write-rejectAfter`, where the screen is right and
# the process was not: the app kept a row it never verified.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var committed \
  --state-var shown \
  --calls-var list=listCalls \
  --calls-var note=noteCalls
