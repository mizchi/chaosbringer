import { readFileSync } from "node:fs";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";
import { silentCreditCardFailures } from "../../../packages/aws-faults/src/wheel/scenarios/silent-credit-card-failures.ts";

const transcript = readFileSync("/tmp/wom-eval/transcript.txt", "utf8");
const toolUses: ToolUseRecord[] = readFileSync("/tmp/wom-eval/tool-uses.jsonl", "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

async function probeCustomer() {
  let ok = 0; const n = 30;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch("http://localhost:3000/orders", { method: "POST", signal: AbortSignal.timeout(3000) });
      if (r.ok) ok++;
    } catch {}
  }
  return { rate: ok / n, sampleN: n };
}

const scenario = silentCreditCardFailures({
  probeUrl: "http://localhost:3000/health",
  customerUrl: "http://localhost:3000/orders",
});
const customerProbe = await probeCustomer();
const drillReport: DrillReport = {
  drillId: "x", passed: true, baseline: [], injected: [],
  injectedByPhase: [{ label: "peak", samples: [{ ok: false, latencyMs: 600, errorRate: 0.2 }] }],
  recovery: Array.from({ length: 20 }, () => ({ ok: true, latencyMs: 12, errorRate: 0 })),
  durationMs: 90_000, recovered: true,
};
const journalContents = [readFileSync("/tmp/wom-eval/journal.md", "utf8")];
const report = scoreScenario({
  scenario, drillReport, transcript, toolUses, journalContents,
  postRunProbes: { "customer-impact-recovered": customerProbe },
});
console.log(report.debrief);
console.log("\nScore:", (report.score * 100).toFixed(0) + "%");
console.log("Customer impact:", customerProbe);
