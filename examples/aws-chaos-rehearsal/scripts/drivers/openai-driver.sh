#!/usr/bin/env bash
# Generic OpenAI-API driver for the rehearsal sweep (issue #116 phase 2).
#
# Demonstrates the contract for non-Anthropic agents. Uses curl
# against the Chat Completions API. The model gets the brief once
# and must produce a journal in the response — limited compared to a
# real tool-using agent, but proves the cross-agent contract.
#
# Requires:
#   - curl, jq
#   - OPENAI_API_KEY
#   - OPENAI_MODEL (e.g. gpt-5, defaults to gpt-4o-mini for the demo)
#
# IMPORTANT: this is a SHIM. The OpenAI Chat Completions API has no
# tool execution — the model cannot actually run Bash to investigate
# / edit / restart the target. The expected score is lower than a
# real Claude Code run since the model can only respond from its
# read of the brief, not from live investigation.
#
# For a real production driver, wire OpenAI's Responses API or your
# own ReAct/tool loop on top of this skeleton.
set -euo pipefail

: "${WOM_BRIEF_PATH:?must be set}"
: "${WOM_WORKDIR:?must be set}"
: "${OPENAI_API_KEY:?must be set}"
MODEL="${OPENAI_MODEL:-gpt-4o-mini}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not on PATH (apt-get install -y jq)" >&2
  exit 127
fi

BRIEF=$(cat "$WOM_BRIEF_PATH")

# Single-turn invocation. Ask the model to emit a journal-shaped
# response that follows the brief's "T+Ns <verb>: <note>" line format.
RESPONSE=$(curl -s https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @<(jq -n --arg model "$MODEL" --arg brief "$BRIEF" '{
    model: $model,
    messages: [
      { role: "system", content: "You are the on-call engineer. Respond ONLY with a journal in the format `T+<sec>s <verb>: <note>` per line, one action per line. End with a short summary. Do NOT execute anything; you have no tools." },
      { role: "user", content: $brief }
    ]
  }'))

if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  echo "[openai-driver] API error:" >&2
  echo "$RESPONSE" | jq '.error' >&2
  exit 1
fi

# Extract the assistant message and write it to journal.md.
echo "$RESPONSE" | jq -r '.choices[0].message.content' > "$WOM_WORKDIR/journal.md"

if [[ ! -s "$WOM_WORKDIR/journal.md" ]]; then
  echo "[openai-driver] empty response from $MODEL" >&2
  exit 1
fi

echo "[openai-driver] journal.md written ($(wc -l < "$WOM_WORKDIR/journal.md") lines)"
