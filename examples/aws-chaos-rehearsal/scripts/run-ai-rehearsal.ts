/**
 * AI recovery rehearsal: boot the env, inject the drill, hand a broken
 * environment to a Claude Agent SDK session, and watch whether SLO recovers
 * while chaos is still active.
 *
 * The agent gets:
 *   - cwd = examples/aws-chaos-rehearsal/  (target source is under target/)
 *   - Bash + Read + Edit + Grep tools
 *   - the drill's `brief` as the user prompt
 *   - environment hint: kumo endpoint, log file paths
 *
 * The orchestrator runs concurrently with the agent:
 *   - keeps probing the target
 *   - resolves when acceptance criteria are met (recovered)
 *   - hard-stops the agent after recoveryTimeoutMs (failure)
 *
 * Crucial design choice: chaos rules are NOT cleared while the agent works.
 * "Wait it out" is not a valid recovery strategy. The agent has to make the
 * target tolerate the fault.
 */
import { resolve } from "node:path";
import { kumoChaos, runDrill } from "@mizchi/aws-faults";
import { ddbThrottleStorm } from "@mizchi/aws-faults/drills";
import { boot } from "./_boot.ts";

// The SDK is imported lazily so this file can be inspected without the
// dependency installed.
async function spawnAgent(brief: string, cwd: string): Promise<() => void> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();

  // Fire and forget; we don't await the iterator because the orchestrator
  // signals completion via the probe loop, not the agent's stop event.
  (async () => {
    try {
      for await (const msg of query({
        prompt: brief,
        options: {
          cwd,
          allowedTools: ["Bash", "Read", "Edit", "Grep", "Glob"],
          // No PII handling, but model is parametric to make this cheap to run.
          model: process.env.REHEARSAL_MODEL ?? "claude-haiku-4-5-20251001",
          abortController: ac,
        },
      })) {
        // Surface tool-use events so the human watching the drill knows the
        // agent is actually doing something.
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              process.stderr.write(`[agent] ${block.text.slice(0, 200)}\n`);
            } else if (block.type === "tool_use") {
              process.stderr.write(`[agent.tool] ${block.name}\n`);
            }
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        process.stderr.write(`[agent] error: ${err}\n`);
      }
    }
  })();

  return () => ac.abort();
}

const env = await boot();

try {
  const chaos = kumoChaos({ endpoint: env.kumoEndpoint });
  const drill = ddbThrottleStorm({
    probeUrl: `${env.targetUrl}/health`,
    probability: 0.5,
  });

  // runDrill's recovery loop keeps probing while the agent works. Spawn the
  // agent exactly once, the first time we see the "injected" phase — that is
  // when the SLO is observably broken and the agent has something to look at.
  const agentHandle: { stop: (() => void) | null; spawning: boolean } = {
    stop: null,
    spawning: false,
  };

  const report = await runDrill({
    chaos,
    drill,
    baselineMs: 5_000,
    recoveryTimeoutMs: 180_000,
    onSample: (phase, s) => {
      const tag = s.ok ? "ok" : "FAIL";
      process.stderr.write(
        `[${phase}] ${tag} latency=${s.latencyMs.toFixed(0)}ms err=${s.errorRate.toFixed(2)}\n`,
      );
      if (phase === "injected" && !agentHandle.spawning && agentHandle.stop === null) {
        agentHandle.spawning = true;
        void spawnAgent(drill.brief ?? drill.description, resolve(import.meta.dirname, "..")).then(
          (stop) => {
            agentHandle.stop = stop;
          },
        );
      }
    },
  });
  agentHandle.stop?.();

  console.error(`\n=== AI rehearsal: ${drill.id} ===`);
  console.error(`recovered: ${report.recovered}`);
  console.error(`duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  console.error(`recovery samples: ${report.recovery.length}`);
  process.exitCode = report.recovered ? 0 : 1;
} finally {
  await env.shutdown();
}
