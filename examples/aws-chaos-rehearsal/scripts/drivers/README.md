# Subprocess drivers for the sweep

The cross-agent leaderboard (#116 phase 2) runs scenarios end-to-end
against a subprocess driver:

```sh
pnpm sweep --driver "<command>" --scenarios <id,id,id> --driver-label <name>
```

For each scenario, sweep:

1. Runs `pnpm prepare <scenario> <run-id>` — spawns the target,
   installs chaos, writes the brief to `<workdir>/agent-brief.txt`.
2. Spawns `<command>` with these env vars:

   | Variable | Meaning |
   |---|---|
   | `WOM_SCENARIO_ID` | scenario being run |
   | `WOM_RUN_ID` | this iteration's run id |
   | `WOM_WORKDIR` | `/tmp/wom-<run-id>` |
   | `WOM_BRIEF_PATH` | file containing the brief (output of prepare) |

3. Waits for the driver to exit. Driver MUST have written
   `<workdir>/journal.md`.
4. Runs `pnpm score <scenario> <run-id>` and records the result.

## Included drivers

| File | What it does |
|---|---|
| `noop-driver.sh` | Writes a canned "I gave up" journal. Useful for smoke-testing the wire-up. |
| `claude-code-driver.sh` | Invokes the `claude` CLI in non-interactive mode with the brief on stdin. Real-agent run. |
| `openai-driver.sh` | Single-turn call against the OpenAI Chat Completions API. Shim — no tool execution; produces a journal-only response. |

## Writing your own driver

Any executable that respects the 4 env vars and produces
`journal.md` in `WOM_WORKDIR` works. Bash, Python, Node, Go,
shell-piped curl — all fine.

Skeleton:

```sh
#!/usr/bin/env bash
set -euo pipefail
: "${WOM_BRIEF_PATH:?must be set}"
: "${WOM_WORKDIR:?must be set}"

# Invoke your agent / model however you like.
my-agent-cli --prompt-file "$WOM_BRIEF_PATH" --work-dir "$WOM_WORKDIR"

# Sanity check.
[[ -s "$WOM_WORKDIR/journal.md" ]] || { echo "no journal written" >&2; exit 1; }
```

Tool-using agents (Claude Code, Cursor agent, your own ReAct loop)
will perform best — the rubric values investigation, hypothesis
statements, and minimal-change mitigations, all of which require
live tool access. Pure single-shot LLM responses (the OpenAI driver)
can produce reasonable journals but cap out at ~50% scores because
they can't actually investigate the running env.

## Running a cross-agent sweep

```sh
# Set up env once (idempotent).
./scripts/bootstrap.sh

# Run the same scenarios with different agents, captured under
# different driver labels so the matrix groups them.
pnpm sweep --driver "bash scripts/drivers/claude-code-driver.sh" \
           --scenarios silent-data-loss,duplicate-orders,multi-service-cascade \
           --driver-label claude-opus-4-7 \
           --report /tmp/sweep-claude.md

pnpm sweep --driver "bash scripts/drivers/openai-driver.sh" \
           --scenarios silent-data-loss,duplicate-orders,multi-service-cascade \
           --driver-label gpt-4o-mini-shim \
           --report /tmp/sweep-openai.md
```

Each invocation's `_replay-inputs.json` and `journal.md` live under
`/tmp/wom-<run-id>/`. Promote interesting runs to checked-in
fixtures (see `examples/aws-chaos-rehearsal/fixtures/`) to make
their scores reproducible across CI.
