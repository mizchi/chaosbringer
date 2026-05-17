import { readFileSync } from "node:fs";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";
import { silentCreditCardFailures } from "../../../packages/aws-faults/src/wheel/scenarios/silent-credit-card-failures.ts";

const transcript = readFileSync("/tmp/wom-eval4/transcript.txt", "utf8");
const toolUses: ToolUseRecord[] = readFileSync("/tmp/wom-eval4/tool-uses.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const journalContents = [readFileSync("/tmp/wom-eval4/journal.md", "utf8")];

async function probeOrders() {
  let ok = 0; const n = 30;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch("http://localhost:3000/orders", { method: "POST", signal: AbortSignal.timeout(5000) });
      if (r.ok) ok++;
    } catch {}
  }
  return { rate: ok / n, sampleN: n };
}
const customerProbe = await probeOrders();
const chaosSnapshot = (await (await fetch("http://localhost:4566/kumo/chaos/rules")).json()) as { rules: { id: string }[]; stats: { ruleId: string; matched: number; skipped: number }[] };

const scenario = silentCreditCardFailures({
  probeUrl: "http://localhost:3000/health",
  customerUrl: "http://localhost:3000/orders",
});
const drillReport: DrillReport = {
  drillId: "x", passed: true, baseline: [], injected: [],
  injectedByPhase: [{ label: "peak", samples: [{ ok: false, latencyMs: 600, errorRate: 0.2 }] }],
  recovery: Array.from({ length: 20 }, () => ({ ok: true, latencyMs: 50, errorRate: 0 })),
  durationMs: 800_000, recovered: true,
};
const report = scoreScenario({
  scenario, drillReport, transcript, toolUses, journalContents,
  postRunProbes: { "customer-impact-recovered": customerProbe },
  postRunChaosSnapshot: chaosSnapshot,
});
console.log(report.debrief);
console.log("\nScore:", (report.score * 100).toFixed(0) + "%");
console.log("Customer:", customerProbe, "  Chaos rules still present:", chaosSnapshot.rules.length);
