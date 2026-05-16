/**
 * Manual drill run (no AI). Boots kumo+target, injects ddbThrottleStorm,
 * polls until the drill's recoveryTimeoutMs elapses, then reports.
 *
 * Use this to:
 *   - sanity-check that the chaos patch is correctly wired
 *   - eyeball the impact a drill has before involving an AI agent
 *   - feed metrics into your own dashboards
 */
import { kumoChaos, runDrill } from "@mizchi/aws-faults";
import { ddbThrottleStorm } from "@mizchi/aws-faults/drills";
import { boot } from "./_boot.ts";

const env = await boot();

try {
  const chaos = kumoChaos({ endpoint: env.kumoEndpoint });

  const report = await runDrill({
    chaos,
    drill: ddbThrottleStorm({
      probeUrl: `${env.targetUrl}/health`,
      probability: 0.5,
    }),
    baselineMs: 5_000,
    recoveryTimeoutMs: 30_000,
  });

  console.error(`\n=== drill ${report.drillId} ===`);
  console.error(`baseline: ${report.baseline.length} samples`);
  console.error(`injected: ${report.injected.length} samples, ${countOk(report.injected)} ok`);
  console.error(`recovery: ${report.recovery.length} samples, ${countOk(report.recovery)} ok`);
  console.error(`recovered: ${report.recovered}`);
  console.error(`duration: ${(report.durationMs / 1000).toFixed(1)}s`);

  // For a manual run without an agent we expect `recovered=false` — the
  // baseline app has no mitigations and the drill keeps faults installed
  // for the full window.
  process.exitCode = report.recovered ? 0 : 1;
} finally {
  await env.shutdown();
}

function countOk(samples: { ok: boolean }[]): number {
  return samples.filter((s) => s.ok).length;
}
