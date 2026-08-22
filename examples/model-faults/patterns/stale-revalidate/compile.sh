#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# Two observables, because the bug lives between them: `shown` is what the page
# renders, and the call count is what says the revalidation happened at all. An
# app that never revalidates and one that revalidates and drops the body are
# different bugs, and a pattern that could only see one of them would keep
# passing for the other.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var shown \
  --calls-var profile=calls
