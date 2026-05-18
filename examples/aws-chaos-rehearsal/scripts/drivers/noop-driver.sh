#!/usr/bin/env bash
# Reference driver — demonstrates the WOM_* env var contract for sweep
# subprocess drivers (issue #116 phase 2).
#
# A real driver would:
#   - Read the brief from $WOM_BRIEF_PATH
#   - Invoke an agent (Claude Code, Cursor CLI, your custom Anthropic SDK
#     harness) against the live env (kumo at :4566, target at :3000)
#   - Append per-action lines to $WOM_WORKDIR/journal.md as the agent works
#   - Exit 0 when the agent is done
#
# This noop driver just writes a hardcoded "I gave up immediately"
# journal so sweep's wire-up can be smoke-tested without an agent.
# Score will be low — that's fine, the point is to prove the contract
# works end-to-end.
set -euo pipefail

: "${WOM_WORKDIR:?must be set}"
: "${WOM_RUN_ID:?must be set}"
: "${WOM_SCENARIO_ID:?must be set}"

cat > "$WOM_WORKDIR/journal.md" <<EOF
T+0s plan: noop driver — I am not a real agent, just demonstrating the contract
T+1s read: ${WOM_BRIEF_PATH:-(no brief path set)}
T+2s investigate: scenario is $WOM_SCENARIO_ID
T+3s plan: a real driver would spawn an LLM here and let it loose
T+5s verify: I have done nothing; this run will score low on purpose
EOF
echo "[noop-driver] wrote journal to $WOM_WORKDIR/journal.md"
