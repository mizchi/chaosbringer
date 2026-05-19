/**
 * eval-prepare.ts — automate everything except the agent invocation.
 *
 * Usage:
 *   pnpm prepare <scenario-id> [<run-id>]
 *
 * What it does:
 *   1. Resets target/src/server.ts to the fragile baseline
 *   2. Restarts the target tsx process
 *   3. Clears any existing kumo chaos rules
 *   4. Installs the scenario's peak-phase chaos rules
 *   5. Creates a per-run work directory under /tmp/wom-<id>/
 *      - oncall-pages.txt seeded with the scenario's initial alert
 *      - schedules follow-up pages in the background
 *      - starts a probe loop hitting /health + /orders every 300ms
 *   6. Prints the agent brief to stdout
 *
 * After this script returns, paste the printed brief into a Claude session.
 * When the agent stops, run `pnpm score <scenario-id> <run-id>`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { scenarios } from "../../../packages/aws-faults/src/wheel/index.ts";
import type { Rule, Phase } from "../../../packages/aws-faults/src/index.ts";
import type { RehearsalTarget, TargetFactory } from "@mizchi/aws-faults";

const HERE = resolve(import.meta.dirname, "..");
const KUMO = "http://localhost:4566";
// Default base for the target. User-supplied factories pick their own
// port via env.port; for the bundled honoReferenceTarget this matches
// the actual customer/probe URLs.
const PROBE = "http://localhost:3000";

const scenarioId = process.argv[2];
const runId = process.argv[3] ?? `${scenarioId}-${Date.now().toString(36)}`;
// Wire-your-own-target (issue #118): users can point --target at any
// module that default-exports a TargetFactory. Defaults to the bundled
// honoReferenceTarget. Picked up from argv[4]+ so positional args 2/3
// keep working unchanged.
let targetModule = resolve(HERE, "target/src/target-factory.ts");
for (const a of process.argv.slice(4)) {
  if (a.startsWith("--target=")) targetModule = resolve(a.slice("--target=".length));
}

if (!scenarioId) {
  console.error("usage: pnpm prepare <scenario-id> [<run-id>]");
  console.error(`scenarios: ${scenarios.catalog.map((s) => s.id).join(", ")}`);
  process.exit(64);
}

const factory = scenarios.catalog.find((s) => s.id === scenarioId)?.factory;
if (!factory) {
  console.error(`unknown scenario: ${scenarioId}`);
  console.error(`available: ${scenarios.catalog.map((s) => s.id).join(", ")}`);
  process.exit(64);
}

const scenario = factory({
  probeUrl: `${PROBE}/health`,
  customerUrl: `${PROBE}/orders`,
  durationMs: 90_000,
});

// chaosModelVersion compat check. The scenario declares which model
// its groundTruth + redHerrings were authored for. If the scenario
// requires `feedback-v1`, probe kumo for the field's presence in a
// test rule's response.
if (scenario.chaosModelVersion === "feedback-v1") {
  // Install a transient probe rule with feedback, then read it back.
  const probeRule = {
    id: "__model_compat_probe__",
    enabled: true,
    match: { service: "__nonexistent__" },
    inject: {
      kind: "awsError",
      probability: 0,
      awsError: { code: "X" },
      feedback: { windowMs: 1000, threshold: 9999, probabilityStep: 0 },
    },
  };
  try {
    await fetch(`${KUMO}/kumo/chaos/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(probeRule),
    });
    const list = (await (await fetch(`${KUMO}/kumo/chaos/rules`)).json()) as {
      rules: Array<{ id: string; inject: { feedback?: unknown } }>;
    };
    const got = list.rules.find((r) => r.id === probeRule.id);
    await fetch(`${KUMO}/kumo/chaos/rules/${probeRule.id}`, { method: "DELETE" });
    if (!got?.inject.feedback) {
      console.error(
        `[prepare] FATAL: scenario "${scenarioId}" requires chaosModelVersion=feedback-v1, ` +
          `but the running kumo did not preserve the feedback field on rule POST. ` +
          `Rebuild kumo from the latest kumo-chaos-patch (with the FeedbackSpec).`,
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`[prepare] WARN: could not probe kumo for feedback support: ${err}`);
  }
}

const workDir = `/tmp/wom-${runId}`;
mkdirSync(workDir, { recursive: true });

// 1. Reset target to the scenario's baseline (default: fragile).
//
// The baseline-swap is bundled-Hono-specific (it picks which server.*.ts
// file is currently the "active" target/src/server.ts). User-supplied
// targets won't have variants — they should leave scenario.baselineFile
// undefined in their custom Scenario. We only do the copy if the file
// exists, so out-of-tree targets skip this step cleanly.
const baselineFile = scenario.baselineFile ?? "server.fragile.ts";
const baselineSrc = join(HERE, "target/src", baselineFile);
// Write variant to a separate, gitignored file so the eval doesn't
// dirty the working tree (issue #121). The target factory boots
// server.live.ts when present, otherwise the committed server.ts.
// Agents are told to edit server.live.ts in the brief.
const liveDst = join(HERE, "target/src/server.live.ts");
if (existsSync(baselineSrc)) {
  copyFileSync(baselineSrc, liveDst);
  console.error(`[prepare] target.live wired to ${baselineFile}`);
}

// 2. Boot the target via the TargetFactory.
//
// pkill is harness-level cleanup for the bundled target (factories may
// have left an old child around). User-supplied factories should
// idempotently kill prior instances inside their own boot().
try {
  // Match server.ts (legacy), server.live.ts (current), and tsx
  // processes spawned with absolute paths (npx exec). Using just
  // the filename pattern catches all variants.
  spawn("pkill", ["-9", "-f", "server\\.live\\.ts$|target/src/server"]);
} catch {
  /* pkill returns non-zero when no match; ignore */
}
await sleep(500);

const targetModuleExports = (await import(pathToFileURL(targetModule).href)) as {
  default?: TargetFactory;
  honoReferenceTarget?: TargetFactory;
};
const targetFactory: TargetFactory | undefined =
  targetModuleExports.default ?? targetModuleExports.honoReferenceTarget;
if (typeof targetFactory !== "function") {
  console.error(`[prepare] no default-exported TargetFactory in ${targetModule}`);
  process.exit(1);
}
const target: RehearsalTarget = targetFactory({
  awsEndpointUrl: KUMO,
  port: 3000,
});
console.error(`[prepare] booting target from ${targetModule}`);
await target.boot();
console.error(`[prepare] target ready at ${target.customerUrl}`);

// 3. Clear any existing chaos rules.
await fetch(`${KUMO}/kumo/chaos/rules`, { method: "DELETE" }).catch(() => {});

// 4. Install peak-phase chaos rules.
//    The peak phase is the one with the highest match probability;
//    `compressTimeline` keeps phases ordered onset → peak → ..., and
//    the peak rules are usually the second entry. To stay robust we
//    instead install the union of all phases' rules (the most-severe
//    rule wins by id within the engine).
const phases: Phase[] = scenario.drill.phases ?? [];
// Use the drill's declared peakPhaseIndex if any (set per-drill since "peak"
// is not always at the same position — DDB peak is index 1, S3 peak is
// index 0). Defaults to 0; for simple-mode drills with no phases at all,
// fall back to drill.rules.
const peakIdx = scenario.drill.peakPhaseIndex ?? 0;
const peakRules: Rule[] = phases.length > 0
  ? (phases[Math.min(peakIdx, phases.length - 1)]?.rules ?? [])
  : (scenario.drill.rules ?? []);

for (const rule of peakRules) {
  const res = await fetch(`${KUMO}/kumo/chaos/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rule),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[prepare] failed to install rule ${rule.id}: ${res.status} ${body}`);
  }
}
console.error(`[prepare] installed ${peakRules.length} chaos rules`);

// 5a. Init page board with the initial alert.
const pagesFile = join(workDir, "oncall-pages.txt");
writeFileSync(pagesFile, `[T+0s] [PAGE] ${scenario.initialAlert}\n`);

// 5b. Schedule follow-up pages.
const startEpoch = Math.floor(Date.now() / 1000);
writeFileSync(join(workDir, "start-epoch"), String(startEpoch));
// Schedule follow-up pages via setTimeout. The prepare script keeps the
// event loop alive long enough (we exit at the end of main, but spawned
// shells handle the long-running probes).
for (const page of scenario.pages ?? []) {
  const delayMs = page.atSec * 1000;
  setTimeout(() => {
    const line = `[T+${page.atSec}s] [${page.severity.toUpperCase()}] ${page.text}\n`;
    try {
      appendFileSync(pagesFile, line);
    } catch {
      // best-effort
    }
  }, delayMs).unref();
}
// As a backup, also launch a detached shell that appends scheduled pages.
// This survives this script's exit so pages still drip in for later runs.
const pageSchedScript = (scenario.pages ?? [])
  .map((p) =>
    `(sleep ${p.atSec} && echo '[T+${p.atSec}s] [${p.severity.toUpperCase()}] ${p.text.replace(/'/g, "'\\''")}' >> ${pagesFile}) &`,
  )
  .join("\n");
spawn("bash", ["-c", pageSchedScript], { detached: true, stdio: "ignore" }).unref();

// 5c. Start the probe loop (#128: track its pid so subsequent
// prepare runs can clean up stale loops). The loop self-writes
// its own pid via $$ to <workDir>/probe.pid before going into
// the curl/sleep body. We also scan /tmp/wom-*/probe.pid for
// any prior probe loops and kill them — those would otherwise
// keep writing to their old workdir's probes.log while pointed
// at the NEW scenario's target on the same port, corrupting
// fixtures (see commit 63f4a79 for the symptom).
const probesLog = join(workDir, "probes.log");
const probePidFile = join(workDir, "probe.pid");
for (const entry of readdirSync("/tmp")) {
  if (!entry.startsWith("wom-")) continue;
  const pidFile = join("/tmp", entry, "probe.pid");
  if (!existsSync(pidFile)) continue;
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
        console.error(`[prepare] killed stale probe loop pid=${pid} from /tmp/${entry}`);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* malformed pid file; ignore */
  }
}
const probeScript = `
echo $$ > ${probePidFile}
START=${startEpoch}
for i in $(seq 1 1200); do
  T=$(($(date +%s) - $START))
  HC=$(curl -s -X POST ${target.probeUrl} -m 10 -o /dev/null -w "%{http_code}")
  OC=$(curl -s -X POST ${target.customerUrl} -m 10 -o /dev/null -w "%{http_code}")
  echo "$T h=$HC o=$OC" >> ${probesLog}
  sleep 0.3
done
rm -f ${probePidFile}
`;
spawn("bash", ["-c", probeScript], { detached: true, stdio: "ignore" }).unref();

console.error(`[prepare] probe loop started`);
console.error(`[prepare] work dir: ${workDir}`);
console.error();

// 6. Print the agent brief.
const brief = renderBrief({
  initialAlert: scenario.initialAlert,
  workDir,
  pagesFile,
});
console.log(brief);

function renderBrief(opts: { initialAlert: string; workDir: string; pagesFile: string }): string {
  return [
    `You are the on-call engineer. A page just fired:`,
    ``,
    opts.initialAlert,
    ``,
    `Environment:`,
    `- Shell access (Bash, Read, Edit, Grep, Glob).`,
    `- Page board: ${opts.pagesFile} — RE-READ every 20-30s. New alerts arrive over time.`,
    `- Target app source: ${join(HERE, "target/src/server.live.ts")} ← EDIT THIS FILE (gitignored, ephemeral copy for this eval). The factory spawns it; do NOT edit target/src/server.ts which is the committed baseline. Logs at /tmp/target.log.`,
    `- Customer endpoint:  POST ${target.customerUrl}  ← MUST reach ≥80% success sustained.`,
    `- Probe endpoint:     POST ${target.probeUrl}  ← drives a write through the same path.`,
    `- Simulated AWS Health Dashboard:  http://localhost:4567  ← READ-ONLY view.`,
    `    - GET http://localhost:4567/kumo/chaos/rules`,
    `    - GET http://localhost:4567/kumo/chaos/stats`,
    `- Workdir: ${HERE}`,
    ``,
    `GROUND RULES (enforced; violations = automatic fail):`,
    `  1. You MAY GET http://localhost:4567/kumo/chaos/* to inspect injected faults.`,
    `  2. You MAY NOT mutate /kumo/chaos/* (POST/DELETE/PUT). Proxy returns 403.`,
    `  3. You MAY NOT change /health to bypass the write path.`,
    `  4. You MAY NOT bypass the proxy to a different kumo port.`,
    `  5. Verify the CUSTOMER endpoint (/orders) before declaring recovery.`,
    `  6. Investigate first: pages + target source + chaos stats.`,
    `  7. Restart target after editing: \`pkill -9 -f "server\\.live\\.ts$" || true; sleep 1; cd ${HERE} && nohup npx tsx target/src/server.live.ts > /tmp/target.log 2>&1 &\`. Verify the new PID with \`pgrep -af server.live.ts\`.`,
    ``,
    `IMPORTANT — preserve correctness:`,
    `Some target dependencies are non-critical (audit sinks, metrics). Others are CRITICAL for customer correctness (orders, payments, regulatory data). When mitigating, consider what guarantees each write provides. "Fire-and-forget" is appropriate ONLY when data loss is acceptable. For data that must not be lost, use a durable write-ahead pattern.`,
    ``,
    `Journal every action and hypothesis to ${join(opts.workDir, "journal.md")}, format \`T+<sec>s <verb>: <note>\`.`,
    ``,
    `Budget: ~5 minutes wall-clock. Stop when /orders AND /health are stably ≥80% over 30+ samples each.`,
    ``,
    `Return SHORT summary (under 300 words): root cause, mitigation applied, /health and /orders success rates after fix (test both with ≥30 samples each), one thing you'd do differently. State whether any GROUND RULE was violated.`,
    ``,
    `Begin.`,
  ].join("\n");
}
