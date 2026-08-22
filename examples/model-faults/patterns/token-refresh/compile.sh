#!/usr/bin/env bash
# Compile this pattern's witnesses into plans.
#
# Two numbers, because the failing rung is where they separate:
#   --state-var refreshes         POSTs the endpoint served, read back from
#                                 /api/refresh/count. The server's own count.
#   --calls-var refresh=refreshCalls  POSTs the client issued, counted by the
#                                 fault layers. A refresh a plan 401s never
#                                 reaches the server, so this is the only
#                                 number that sees it — and the stampede is a
#                                 number of requests, not of answers.
#
# `--ignore-action refresh` is gone with the atomic `refreshAndReplay` it
# existed for: the refresh is an operation now (`op: "refresh"`), so its log
# entries are `fulfil` / `status` on that operation and the bridge can fault it.
set -euo pipefail
cd "$(dirname "$0")"
CLI="${CLI:-../../../../packages/chaosbringer/dist/cli.js}"
node "$CLI" model compile \
  --traces "${TRACES:-traces}" \
  --out "${OUT:-plans}" \
  --state-var refreshes \
  --calls-var refresh=refreshCalls
