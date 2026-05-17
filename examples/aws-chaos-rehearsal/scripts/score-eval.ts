// Run the official rubric primitives against the captured transcript to
// get the same score the prod runScenario would produce.
import { readFileSync } from "node:fs";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { Scenario, ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";
import { silentCreditCardFailures } from "../../../packages/aws-faults/src/wheel/scenarios/silent-credit-card-failures.ts";

const transcript = readFileSync("/tmp/wom-eval/transcript.txt", "utf8");
const toolUses: ToolUseRecord[] = readFileSync("/tmp/wom-eval/tool-uses.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

// Construct a drill report mirroring what the live orchestrator would have observed.
// We use the actual /health probe ratios from /tmp/wom-eval/probes.log.
const drillReport: DrillReport = {
  drillId: "aws-2015-09-20-dynamodb",
  passed: true,
  baseline: [],
  injected: [],
  injectedByPhase: [
    { label: "peak", samples: [{ ok: false, latencyMs: 600, errorRate: 0.2 }] },
  ],
  // /health was 100% green post-mitigation (T+80s onward).
  recovery: Array.from({ length: 20 }, () => ({ ok: true, latencyMs: 12, errorRate: 0 })),
  durationMs: 90_000,
  recovered: true,
};

const scenario: Scenario = silentCreditCardFailures({ probeUrl: "http://localhost:3000/health" });
const report = scoreScenario({ scenario, drillReport, transcript, toolUses });

console.log(report.debrief);
console.log("\n---");
console.log(`Score: ${(report.score * 100).toFixed(0)}%`);
console.log(`Red herrings followed: ${report.redHerringsHit.length === 0 ? "none" : report.redHerringsHit.join("; ")}`);
