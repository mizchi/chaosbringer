#!/usr/bin/env bash
# Claude Code CLI driver for the rehearsal sweep (issue #116 phase 2).
#
# Invokes `claude` (the Claude Code CLI) with the brief as a single
# non-interactive prompt. The agent has filesystem + Bash access via
# Claude Code's default tools, so it journals to $WOM_WORKDIR
# directly per the brief instructions.
#
# Requires:
#   - `claude` (Claude Code CLI) on PATH
#   - ANTHROPIC_API_KEY (or Claude Code's other auth modes)
#
# Use with sweep:
#   pnpm sweep --driver "bash scripts/drivers/claude-code-driver.sh" \
#              --scenarios silent-data-loss,duplicate-orders \
#              --driver-label claude-opus-4-7
set -euo pipefail

: "${WOM_BRIEF_PATH:?must be set}"
: "${WOM_WORKDIR:?must be set}"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH. Install it from https://docs.claude.com/claude-code" >&2
  exit 127
fi

# `claude -p` runs a single non-interactive turn. The brief is
# self-contained and ends with "Begin." — the agent should journal
# and return a short summary.
#
# --print emits the agent's final message to stdout (which sweep
# captures but does not require).
#
# --output-format text is the default; pass --verbose for stream-json
# if you want to record the full transcript to a file.
claude -p \
  --output-format text \
  < "$WOM_BRIEF_PATH" \
  > "$WOM_WORKDIR/agent-summary.txt" \
  2> "$WOM_WORKDIR/agent-stderr.log"

# Sanity: the brief tells the agent to journal at $WOM_WORKDIR/journal.md.
# If that file is missing the run won't score — surface the failure.
if [[ ! -s "$WOM_WORKDIR/journal.md" ]]; then
  echo "[claude-driver] no journal.md was written — agent did not follow brief" >&2
  echo "[claude-driver] see $WOM_WORKDIR/agent-summary.txt and $WOM_WORKDIR/agent-stderr.log" >&2
  exit 1
fi

echo "[claude-driver] journal.md written ($(wc -l < "$WOM_WORKDIR/journal.md") lines)"
