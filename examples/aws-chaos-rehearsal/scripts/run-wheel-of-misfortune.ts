/**
 * Wheel of Misfortune: real broken system + faked alert stream + scored debrief.
 *
 * 1. Spin the wheel — pick a scenario at random (or pass SCENARIO=<id>)
 * 2. Boot kumo + target
 * 3. Hand the agent a real PagerDuty-shaped alert (NO debugging hints)
 * 4. Run the underlying drill (replay of a real AWS incident)
 * 5. While drill runs, schedule follow-up pages to the page board
 * 6. When drill ends, stop agent, score transcript, write debrief.md
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { kumoChaos } from "@mizchi/aws-faults";
import { runScenario, scenarios } from "@mizchi/aws-faults/wheel";
import type { AgentHandle, AgentBriefing } from "@mizchi/aws-faults/wheel";
import type { ToolUseRecord } from "@mizchi/aws-faults/wheel";
import { boot } from "./_boot.ts";

const env = await boot();

try {
  const chaos = kumoChaos({ endpoint: env.kumoEndpoint });

  // Pick a scenario. SCENARIO=morning-rush-cognito to force one; otherwise random.
  const factory =
    scenarios.catalog.find((s) => s.id === process.env.SCENARIO)?.factory ??
    scenarios.pickScenario();

  const scenario = factory({
    probeUrl: `${env.targetUrl}/health`,
    durationMs: 90_000,
  });

  console.error(`\n=== Wheel of Misfortune ===`);
  console.error(`Scenario: ${scenario.title}`);
  console.error(`(scenario id: ${scenario.id})`);
  console.error("");

  const workDir = mkdtempSync(join(tmpdir(), "wom-"));
  console.error(`Work dir: ${workDir}\n`);

  const report = await runScenario({
    chaos,
    scenario,
    workDir,
    baselineMs: 5_000,
    recoveryTimeoutMs: 180_000,
    driver: claudeAgentDriver,
    onSample: (phase, ok) => {
      process.stderr.write(`[${phase}] ${ok ? "ok" : "FAIL"}\n`);
    },
  });

  console.error("\n=========== DEBRIEF ===========\n");
  console.error(report.debrief);
  console.error("\n========================");
  console.error(`Score: ${(report.score * 100).toFixed(0)}%`);
  console.error(`Recovered: ${report.drillReport.recovered}`);
  console.error(`Artifacts: ${workDir}`);
  console.error("========================\n");

  process.exitCode = report.passed ? 0 : 1;
} finally {
  await env.shutdown();
}

/**
 * Driver bridging the @anthropic-ai/claude-agent-sdk's streaming events to
 * the WoM scoring rubric's plain text + tool-use list shape.
 */
async function claudeAgentDriver(briefing: AgentBriefing): Promise<AgentHandle> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  const start = Date.now();
  const transcriptParts: string[] = [];
  const toolUses: ToolUseRecord[] = [];

  const prompt =
    briefing.initialAlert +
    "\n\nYou are the on-call engineer. Watch " +
    briefing.pageBoardPath +
    " for follow-up pages. Source code lives under target/. " +
    "kumo runs at http://localhost:4566 and exposes /kumo/chaos/{rules,stats}. " +
    "Recover the SLO.";

  const iter = (async () => {
    try {
      for await (const msg of query({
        prompt,
        options: {
          cwd: briefing.workDir === "/" ? resolve(import.meta.dirname, "..") : briefing.workDir,
          allowedTools: ["Bash", "Read", "Edit", "Grep", "Glob"],
          model: process.env.REHEARSAL_MODEL ?? "claude-haiku-4-5-20251001",
          abortController: ac,
        },
      })) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              transcriptParts.push(block.text);
              process.stderr.write(`[agent] ${block.text.slice(0, 200)}\n`);
            } else if (block.type === "tool_use") {
              const input = normalizeToolInput(block.name, block.input as Record<string, unknown>);
              toolUses.push({
                name: block.name,
                input,
                atSec: (Date.now() - start) / 1000,
              });
              process.stderr.write(`[agent.tool] ${block.name} ${input.slice(0, 80)}\n`);
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

  return {
    finalize: async () => {
      ac.abort();
      // Give the SDK a moment to flush its iterator.
      await Promise.race([iter, new Promise((r) => setTimeout(r, 2_000))]);
      return { transcript: transcriptParts.join("\n\n"), toolUses };
    },
  };
}

function normalizeToolInput(name: string, input: Record<string, unknown>): string {
  // Compact a single descriptive string per tool so the rubric's regex
  // primitives have something stable to match against.
  if (name === "Bash") return String(input.command ?? "");
  if (name === "Read" || name === "Write") return String(input.file_path ?? "");
  if (name === "Edit") return String(input.file_path ?? "");
  if (name === "Grep") return `${String(input.pattern ?? "")} in ${String(input.path ?? ".")}`;
  if (name === "Glob") return String(input.pattern ?? "");
  return JSON.stringify(input);
}
