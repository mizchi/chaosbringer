/**
 * Wheel of Misfortune runner.
 *
 * Composes runDrill with:
 *   - A "page board" file the agent watches for incoming alerts
 *   - Scheduled page events that simulate cascading PagerDuty notifications
 *   - Transcript capture so the rubric can score the agent post-hoc
 *
 * The runner is agent-host agnostic: it takes a callback that returns the
 * agent transcript when the agent stops. The example wires this up to the
 * Claude Agent SDK; tests use a fixture transcript.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { KumoChaos } from "../client.ts";
import { runDrill } from "../orchestrator.ts";
import type { DrillReport } from "../orchestrator.ts";
import type { Scenario, ScenarioReport, ToolUseRecord } from "./types.ts";
import { scoreScenario } from "./scoring.ts";

export interface RunScenarioOptions {
  chaos: KumoChaos;
  scenario: Scenario;
  /**
   * Directory where the page board, transcript, and report are written.
   * Created if it does not exist. The agent should be spawned with this
   * as its cwd (or with the page board path passed in its prompt).
   */
  workDir: string;
  /**
   * Agent driver. Called once the initial alert is written. Should spawn
   * the agent (with whatever tooling the caller wants — Claude Agent SDK,
   * subprocess `claude`, mocked transcript for tests, etc.) and return
   * a handle with the transcript + tool uses captured so far.
   *
   * The orchestrator will continue running runDrill in parallel; the
   * driver returns a `stop()` to terminate the agent on drill end.
   */
  driver: (briefing: AgentBriefing) => Promise<AgentHandle>;
  baselineMs?: number;
  recoveryTimeoutMs?: number;
  /** Called for each drill sample, for live logging. */
  onSample?: (phase: string, ok: boolean) => void;
}

export interface AgentBriefing {
  initialAlert: string;
  pageBoardPath: string;
  /** Absolute path to the agent's working directory (target source lives under target/). */
  workDir: string;
}

export interface AgentHandle {
  /** Stops the agent and returns the final transcript + tool uses. */
  finalize: () => Promise<{ transcript: string; toolUses: ToolUseRecord[] }>;
}

export async function runScenario(opts: RunScenarioOptions): Promise<ScenarioReport> {
  await mkdir(opts.workDir, { recursive: true });

  const pageBoardPath = resolve(opts.workDir, "oncall-pages.txt");
  await writeFile(pageBoardPath, `[T+0s] [PAGE] ${opts.scenario.initialAlert}\n`);

  const start = Date.now();

  // Schedule subsequent pages.
  const pages = opts.scenario.pages ?? [];
  const pageTimers = pages.map((p) =>
    setTimeout(() => {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const tag = p.severity.toUpperCase();
      // best-effort; don't crash the scenario if disk write fails
      void appendFile(pageBoardPath, `[T+${elapsed}s] [${tag}] ${p.text}\n`).catch(() => {});
    }, p.atSec * 1000),
  );

  // Hand the agent a real-shaped briefing.
  const agentHandle = await opts.driver({
    initialAlert: opts.scenario.initialAlert,
    pageBoardPath,
    workDir: opts.workDir,
  });

  // Run the underlying drill. We do this AFTER spawning the agent so the
  // agent sees the failure happen, like a real on-call.
  const drillReport: DrillReport = await runDrill({
    chaos: opts.chaos,
    drill: opts.scenario.drill,
    baselineMs: opts.baselineMs,
    recoveryTimeoutMs: opts.recoveryTimeoutMs,
    onSample: opts.onSample
      ? (phase, sample) => opts.onSample!(phase, sample.ok)
      : undefined,
  });

  // Stop the agent and collect its transcript.
  for (const t of pageTimers) clearTimeout(t);
  const { transcript, toolUses } = await agentHandle.finalize();

  // Score.
  const report = scoreScenario({
    transcript,
    toolUses,
    drillReport,
    scenario: opts.scenario,
  });

  // Persist artifacts.
  await writeFile(resolve(opts.workDir, "transcript.txt"), transcript);
  await writeFile(
    resolve(opts.workDir, "tool-uses.jsonl"),
    toolUses.map((t) => JSON.stringify(t)).join("\n"),
  );
  await writeFile(resolve(opts.workDir, "debrief.md"), report.debrief);
  await writeFile(
    resolve(opts.workDir, "report.json"),
    JSON.stringify(
      {
        scenarioId: report.scenarioId,
        passed: report.passed,
        score: report.score,
        criteria: report.criteria,
        redHerringsHit: report.redHerringsHit,
        recovered: drillReport.recovered,
        durationMs: drillReport.durationMs,
      },
      null,
      2,
    ),
  );

  return report;
}
