/**
 * `chaosbringer model <compile|run>`.
 *
 * Two stages with deliberately different dependency footprints:
 *
 *   compile  ITF traces (from `quint verify --out-itf`) → plan JSON files.
 *            Pure Node, no browser. Run it when the model changes and
 *            commit the plans.
 *   run      plan JSON files → deterministic browser runs + oracle check.
 *            No Quint, no JVM: CI only ever needs this half.
 *
 * Enumeration itself (asking a model checker for one witness per target
 * state) stays out of the CLI on purpose — it is a `quint verify` loop over
 * a target list, and wrapping it here would bake a Quint/Apalache
 * dependency into a package whose whole point is not needing one at run
 * time. `examples/model-faults/enumerate.sh` is the reference loop.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { aggregateCoverage, formatModelCoverage, modelRunPassed } from "./coverage.js";
import { parseItfTrace } from "./itf.js";
import { compilePlan, markOrderSensitivePlans, validatePlan, type FaultPlan } from "./plan.js";
import { runPlans, type RunPlanOptions } from "./runner.js";

const HELP = `Usage: chaosbringer model <command> [options]

Model-driven fault coverage: a temporal-logic model enumerates the failure
states, each state replays as a deterministic run, and the model's own
prediction is the oracle.

Commands:
  compile --traces <dir> --out <dir>
      Compile ITF traces (*.itf.json, from \`quint verify --out-itf\` or
      \`quint run --out-itf\`) into plan files. Plans that inject the same
      outcomes but predict different results are flagged orderSensitive —
      cross-operation settlement order is not enforceable in a browser.

      --log-var <name>       Model variable holding the event log (default: log)
      --ui-var <name>        Variable holding the expected UI label (default: ui)
      --unhandled-var <name> Variable holding the escaped-rejection flag
                             (default: unhandled)

  run --plans <dir> --url <url> --config <file>
      Replay every plan and check its oracle. Exits 1 on any mismatch,
      skipped plan, or plan whose faults never fired.

      --config <file>   JS/TS module default-exporting the bridge:
                        { rules, action?, uiProbe?, settleMs?, timeout? }
                        \`rules\` maps model operation ids to URL matchers.
      --allow-order-sensitive  Run flagged plans anyway.
      --output <file>    Write the coverage report (JSON) here.
      --json             Print the coverage report instead of the summary.

Examples:
  chaosbringer model compile --traces model/traces --out model/plans
  chaosbringer model run --plans model/plans --url http://localhost:3000 \\
    --config model/bridge.mjs
`;

function listFiles(dir: string, suffix: string): string[] {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat) throw new Error(`no such directory: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => join(dir, f));
}

/** Strip the ITF / plan suffix so a plan's name matches its file stem. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.itf\.json$/, "").replace(/\.plan\.json$/, "").replace(/\.json$/, "");
}

export function compilePlansFromTraces(
  tracePaths: readonly string[],
  opts: { logVar?: string; uiVar?: string; unhandledVar?: string } = {},
): FaultPlan[] {
  const plans = tracePaths.map((path) => {
    const trace = parseItfTrace(JSON.parse(readFileSync(path, "utf8")));
    return compilePlan(trace, {
      name: stemOf(path),
      ...(opts.logVar !== undefined ? { logVar: opts.logVar } : {}),
      ...(opts.uiVar !== undefined ? { uiVar: opts.uiVar } : {}),
      ...(opts.unhandledVar !== undefined ? { unhandledVar: opts.unhandledVar } : {}),
    });
  });
  return markOrderSensitivePlans(plans);
}

async function runCompile(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      traces: { type: "string" },
      out: { type: "string" },
      "log-var": { type: "string" },
      "ui-var": { type: "string" },
      "unhandled-var": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help || !values.traces || !values.out) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const tracePaths = listFiles(resolve(values.traces), ".itf.json");
  if (tracePaths.length === 0) {
    console.error(`model compile: no *.itf.json files in ${values.traces}`);
    process.exitCode = 1;
    return;
  }
  const plans = compilePlansFromTraces(tracePaths, {
    ...(values["log-var"] !== undefined ? { logVar: values["log-var"] } : {}),
    ...(values["ui-var"] !== undefined ? { uiVar: values["ui-var"] } : {}),
    ...(values["unhandled-var"] !== undefined ? { unhandledVar: values["unhandled-var"] } : {}),
  });

  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  for (const plan of plans) {
    validatePlan(plan);
    writeFileSync(join(outDir, `${plan.name}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`);
  }
  const flagged = plans.filter((p) => p.orderSensitive);
  console.log(`model compile: ${plans.length} plan(s) -> ${values.out}`);
  for (const plan of plans) {
    const steps = plan.schedule.map((s) => `${s.rule}@${s.occurrence}=${s.outcome}`).join(" ");
    console.log(
      `  ${plan.name}: [${steps}] -> ui=${plan.expect.ui ?? "?"} unhandled=${plan.expect.unhandledRejection ?? "?"}${plan.orderSensitive ? "  (order-sensitive)" : ""}`,
    );
  }
  if (flagged.length > 0) {
    console.log(
      `\n${flagged.length} plan(s) are order-sensitive: the same injections with different predicted outcomes.\n` +
        `Cross-operation settlement order is not enforceable in a browser, so \`model run\` skips them\n` +
        `unless --allow-order-sensitive is passed. Refine the model (or split the operations) to fix.`,
    );
  }
}

/** Bridge module shape for `model run --config`. */
export type ModelBridge = Omit<RunPlanOptions, "baseUrl"> & { baseUrl?: string };

async function loadBridge(path: string): Promise<ModelBridge> {
  const mod = (await import(resolve(path))) as { default?: ModelBridge } & ModelBridge;
  const bridge = mod.default ?? mod;
  if (!bridge || typeof bridge !== "object" || typeof bridge.rules !== "object") {
    throw new Error(
      `model run: ${path} must default-export { rules, action?, uiProbe?, … } (rules maps model operation ids to URL matchers)`,
    );
  }
  return bridge;
}

async function runRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plans: { type: "string" },
      url: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      "allow-order-sensitive": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help || !values.plans || !values.url || !values.config) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const planPaths = listFiles(resolve(values.plans), ".json");
  if (planPaths.length === 0) {
    console.error(`model run: no plan files in ${values.plans}`);
    process.exitCode = 1;
    return;
  }
  const plans: FaultPlan[] = planPaths.map((p) => {
    const plan = JSON.parse(readFileSync(p, "utf8")) as FaultPlan;
    validatePlan(plan);
    return plan;
  });

  const bridge = await loadBridge(values.config);
  const results = await runPlans(plans, {
    ...bridge,
    baseUrl: values.url,
    ...(values["allow-order-sensitive"] ? { allowOrderSensitive: true } : {}),
  });

  const coverage = aggregateCoverage(results, {
    ...(plans[0]?.spec !== undefined ? { spec: plans[0].spec } : {}),
  });
  if (values.json) {
    console.log(JSON.stringify(coverage, null, 2));
  } else {
    console.log(formatModelCoverage(coverage));
  }
  if (values.output) {
    const out = resolve(values.output);
    mkdirSync(resolve(out, ".."), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ coverage, results: results.map(stripReport) }, null, 2)}\n`);
  }
  if (!modelRunPassed(coverage)) process.exitCode = 1;
}

/** Reports are large and already written elsewhere; keep the JSON readable. */
function stripReport(r: Awaited<ReturnType<typeof runPlans>>[number]): unknown {
  const { report, ...rest } = r;
  return { ...rest, pagesVisited: report?.pagesVisited };
}

export async function runModelCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "compile":
      await runCompile(rest);
      return;
    case "run":
      await runRun(rest);
      return;
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`model: unknown command "${command}"`);
      console.log(HELP);
      process.exitCode = 1;
  }
}
