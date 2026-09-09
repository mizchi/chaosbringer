/**
 * `chaosbringer model <calibrate|compile|run|shrink>`.
 *
 * Three stages with deliberately different dependency footprints:
 *
 *   calibrate  measure what this machine can honour (browser, no Quint) and
 *              write a timing profile. Numbers are per-machine, so the
 *              profile is an artifact of the environment, not of the model.

 *   compile  ITF traces (from `quint verify --out-itf`) → plan JSON files.
 *            Pure Node, no browser. Run it when the model changes and
 *            commit the plans.
 *   run      plan JSON files → deterministic browser runs + oracle check.
 *            No Quint, no JVM: CI only ever needs this half.
 *   shrink   one failing plan → the smallest plan that still fails the same
 *            way. A model checker returns whichever counterexample its search
 *            reached first, which is routinely far longer than the bug; this
 *            re-runs smaller candidates until none of them still fails.
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
import {
  compilePlan,
  markOrderSensitivePlans,
  validatePlan,
  DEFAULT_IGNORED_ACTIONS,
  PLAN_OUTCOMES,
  type CompilePlanOptions,
  type FaultPlan,
} from "./plan.js";
import {
  MISMATCH_FIELDS,
  fingerprintsOf,
  resolvePlanTiming,
  runPlan,
  runPlans,
  type MismatchField,
  type RunPlanOptions,
} from "./runner.js";
import { shrinkPlan } from "./shrink.js";

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
      --state-var <name>     Extra model variable to lift into expect.state,
                             compared against the bridge's stateProbe. Repeatable.
                             Use for observables the UI does not show: write
                             counts, refresh counts, rollback flags.
      --calls-var <op>=<var> Model variable holding an operation's TOTAL call
                             count, lifted into expect.calls.<op>. Repeatable.
                             The schedule says what happens to call 0 and call
                             1; only this can say that call 2 does not exist.
                             Compared against what the fault layers counted,
                             page-load calls included.
      --ignore-action <name> A model action that is app behaviour rather than an
                             injection (a token refresh the app performs on its
                             own, say). Repeatable; added to the built-in list
                             of init/start/stutter.

  calibrate --url <url> [--out <file>]
      Measure what THIS machine can honour and write a timing profile:
      the injection floor, the jitter tails, and the fixed per-plan cost.
      Timing values are then solved from it instead of guessed.

      --runs <n>        Calibration runs to take the envelope over (default 3).
                        A warm run under-reports the tail, so more than one.
      --samples <n>     Fetches per nominal delay, per run (default 20).
      --probe-path <p>  Path the probe fetches (default: the URL's own path).

  run --plans <dir> --url <url> --config <file>
      Replay every \`*.plan.json\` in <dir> and check its oracle. Exits 1 on
      any mismatch, skipped plan, or plan whose faults never fired — including
      a plan whose every step is \`pass\` and whose operation the app never
      called.

      --config <file>   JS/TS module default-exporting the bridge:
                        { rules, action?, uiProbe?, stateProbe?, uiInvariants?,
                          settleMs?, quiescenceMs?, appDeadlineMs?,
                          asyncDrainCapMs?, checkAmplification?, timeout?,
                          coverageFingerprints? }
                        Set \`coverageFingerprints: true\` to have the report
                        name plans the model calls distinct states but whose
                        executed code was identical.
                        \`rules\` maps model operation ids to URL matchers.
                        \`uiInvariants\` says what each ui label promises about
                        the page, keyed by label (\`"*"\` for all of them):
                        a right label over a wrong page is otherwise a pass.
      --allow-order-sensitive  Run flagged plans anyway.
      --output <file>    Write the coverage report (JSON) here.
      --json             Print the coverage report instead of the summary.

  shrink --plan <file> --url <url> --config <file>
      Minimise ONE failing plan: drop the steps that do not matter, weaken
      the outcomes that do not need to be that strong, and lower the
      occurrences that do not need to be that late. Each candidate is a real
      browser run judged by the same oracle as \`model run\`, so the result is
      a plan that provably still fails — not a guess.

      Exits 0 only when the search finished the job. A plan that did not
      reproduce, a run budget that ran out, or a candidate the oracle could
      not judge all exit 1 and say which: a minimum nobody established is not
      a minimum.

      --out <file>       Write the minimised plan here (as *.plan.json).
      --target <fields>  Comma-separated mismatch fields the minimum must keep
                         reproducing. Default: whatever the first run of the
                         plan reports. Narrow it when one plan trips several
                         checks and you only care about one.

      Only CONTRACT findings can be shrunk: an escaping rejection (needs
      \`expect.unhandledRejection: false\`) and a \`uiInvariant\` violation.
      \`ui\`, \`state\`, \`injection\` and \`amplification\` compare against the
      model's prediction for that exact schedule, and a smaller schedule has
      no recomputed prediction — shrinking on them would "minimise" the plan
      to one that injects nothing and still call it a reproduction. Such a
      plan exits 1 with \`schedule-relative\`; minimise the model instead.
      --max-runs <n>     Candidate runs to spend, baseline included
                         (default 100). Each one boots a browser.
      --retries <n>      Re-runs to spend on a candidate the oracle could not
                         judge before giving up on it (default 1).
      --allow-order-sensitive  Shrink a flagged plan anyway. Without this an
                         order-sensitive plan is skipped by the runner, so
                         every candidate is unjudgeable and the search stops.
      --json             Print the full result, including the run log.

Examples:
  chaosbringer model calibrate --url http://localhost:3000 --out model/profile.json
  chaosbringer model compile --traces model/traces --out model/plans
  chaosbringer model run --plans model/plans --url http://localhost:3000 \\
    --config model/bridge.mjs
  chaosbringer model shrink --plan model/plans/refresh-storm.plan.json \\
    --url http://localhost:3000 --config model/bridge.mjs --out min.plan.json
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

/**
 * Parse a count flag, naming the flag and the value when it is not one.
 *
 * `--runs abc` used to reach `envelope([])` and die with "no calibration runs
 * to aggregate", a message about an internal invariant rather than about the
 * thing the operator typed.
 */
function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`model calibrate: ${flag} needs a positive integer, got "${raw}"`);
  }
  return n;
}

/** Strip the ITF / plan suffix so a plan's name matches its file stem. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.itf\.json$/, "").replace(/\.plan\.json$/, "").replace(/\.json$/, "");
}

/**
 * Compile every trace in `tracePaths`, then flag the order-sensitive ones.
 *
 * `opts` is `CompilePlanOptions` minus the per-trace name, and it is forwarded
 * whole. It used to be a hand-written mirror of those fields, which is exactly
 * how `callsVars` came to be accepted by the CLI, typechecked, and then
 * dropped on the floor — a spread argument suppresses excess-property
 * checking, so nothing complained. Derive the type; do not restate it.
 */
export function compilePlansFromTraces(
  tracePaths: readonly string[],
  opts: Omit<CompilePlanOptions, "name"> = {},
): FaultPlan[] {
  const plans = tracePaths.map((path) => {
    const trace = parseItfTrace(JSON.parse(readFileSync(path, "utf8")));
    return compilePlan(trace, {
      ...opts,
      name: stemOf(path),
      // Extend rather than replace: a caller naming one app-behaviour action
      // does not mean init/start should suddenly become injections.
      ...(opts.ignoreActions !== undefined
        ? { ignoreActions: [...DEFAULT_IGNORED_ACTIONS, ...opts.ignoreActions] }
        : {}),
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
      "state-var": { type: "string", multiple: true },
      "calls-var": { type: "string", multiple: true },
      "ignore-action": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help || !values.traces || !values.out) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  // `--calls-var list=listCalls`: the operation on the left, the model
  // variable on the right. Malformed input is an error rather than a silently
  // ignored flag — a call bound nobody applied is worse than no bound.
  const callsVars: Record<string, string> = {};
  for (const pair of values["calls-var"] ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1 || eq === pair.length - 1) {
      console.error(`model compile: --calls-var expects <operation>=<variable>, got "${pair}"`);
      process.exitCode = 1;
      return;
    }
    callsVars[pair.slice(0, eq)] = pair.slice(eq + 1);
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
    ...(values["state-var"] !== undefined ? { stateVars: values["state-var"] } : {}),
    ...(Object.keys(callsVars).length > 0 ? { callsVars } : {}),
    ...(values["ignore-action"] !== undefined ? { ignoreActions: values["ignore-action"] } : {}),
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
    const state = plan.expect.state
      ? ` ${Object.entries(plan.expect.state).map(([k, v]) => `${k}=${v}`).join(" ")}`
      : "";
    // Every expectation the plan carries goes in the line. A field that is
    // emitted but never printed is a field nobody notices is missing.
    const calls = plan.expect.calls
      ? ` ${Object.entries(plan.expect.calls).map(([k, v]) => `calls.${k}=${v}`).join(" ")}`
      : "";
    console.log(
      `  ${plan.name}: [${steps}] -> ui=${plan.expect.ui ?? "?"} unhandled=${plan.expect.unhandledRejection ?? "?"}${state}${calls}${plan.orderSensitive ? "  (order-sensitive)" : ""}`,
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

  // `.plan.json`, not `.json`: `model compile` writes that suffix and
  // `stemOf` strips it, so a `profile.json` or `targets.json` living beside
  // the plans is not a plan and must not die as `plan is missing a "name"`.
  const planPaths = listFiles(resolve(values.plans), ".plan.json");
  if (planPaths.length === 0) {
    console.error(`model run: no *.plan.json files in ${values.plans}`);
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

  const coverage = coverageForRun(plans, results);
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

/**
 * Assemble the coverage report for a `model run`.
 *
 * Split out so the one thing that cannot be seen by reading the call — that
 * the fingerprints the run collected are actually handed to
 * `aggregateCoverage` — is a unit test rather than a browser run. Without
 * that argument `collapsedPlans` is unconditionally empty for every CLI user
 * however the bridge is configured: the digests get collected and the report
 * drops them. That is the same defect as the one already found and fixed in
 * `examples/model-faults/patterns/run-pattern.mts`, and it recurred here
 * because nothing asserted the wiring.
 */
export function coverageForRun(
  plans: readonly FaultPlan[],
  results: readonly Awaited<ReturnType<typeof runPlans>>[number][],
): ReturnType<typeof aggregateCoverage> {
  return aggregateCoverage(results, {
    ...(plans[0]?.spec !== undefined ? { spec: plans[0].spec } : {}),
    fingerprints: fingerprintsOf(results),
  });
}

/** Reports are large and already written elsewhere; keep the JSON readable. */
function stripReport(r: Awaited<ReturnType<typeof runPlans>>[number]): unknown {
  const { report, ...rest } = r;
  return { ...rest, pagesVisited: report?.pagesVisited };
}

async function runCalibrate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      out: { type: "string" },
      runs: { type: "string" },
      samples: { type: "string" },
      "probe-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help || !values.url) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const { calibrateTiming } = await import("./calibrate.js");
  const { solveTiming } = await import("../timing.js");
  const result = await calibrateTiming({
    url: values.url,
    ...(values["probe-path"] !== undefined ? { probePath: values["probe-path"] } : {}),
    ...(values.runs !== undefined ? { runs: positiveInt(values.runs, "--runs") } : {}),
    ...(values.samples !== undefined ? { samples: positiveInt(values.samples, "--samples") } : {}),
    onProgress: (m) => console.error(`  ${m}`),
  });

  const json = `${JSON.stringify(result.profile, null, 2)}\n`;
  if (values.out) {
    const out = resolve(values.out);
    mkdirSync(resolve(out, ".."), { recursive: true });
    writeFileSync(out, json);
    console.log(`model calibrate: profile -> ${values.out}`);
  }
  console.log(json.trimEnd());

  // The profile alone is abstract; show what it implies for a plausible
  // deadline so the operator can sanity-check it against their app.
  for (const deadline of [500, 5000]) {
    const solved = solveTiming(result.profile, { deadlineMs: deadline });
    if (solved.status === "sat") {
      console.log(
        `\nat a ${deadline}ms app deadline: settleMs=${solved.settleMs}, ` +
          `tolerated delay <=${solved.fastMs}ms, tripping delay >=${solved.slowMs}ms, ` +
          `~${solved.wallClockMs}ms per plan`,
      );
    } else {
      console.log(`\nat a ${deadline}ms app deadline: INFEASIBLE — ${solved.explanation}`);
    }
  }
}

/**
 * Parse `--target ui,state` into fields, rejecting a name that is not one.
 *
 * Silently dropping a typo would leave the search targeting fewer fields than
 * the operator asked for — and if it drops the *only* field, targeting
 * nothing, which reproduces on nothing and reports the original plan as its
 * own minimum. A misspelled flag has to be an error.
 */
export function parseTargetFields(raw: string): MismatchField[] {
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) {
    throw new Error(`model shrink: --target was empty; give at least one mismatch field`);
  }
  const known = new Set<string>(MISMATCH_FIELDS);
  const bad = names.filter((n) => !known.has(n));
  if (bad.length > 0) {
    throw new Error(
      `model shrink: --target has no such mismatch field: ${bad.join(", ")}. ` +
        `Known fields: ${MISMATCH_FIELDS.join(", ")}`,
    );
  }
  return names as MismatchField[];
}

/** One-line summary of what the shrink achieved, and of what it did not. */
export function formatShrinkResult(result: {
  original: { schedule: readonly unknown[] };
  minimal: { schedule: readonly unknown[] };
  target: readonly string[];
  excludedTarget?: readonly string[];
  runs: number;
  stop: string;
  note?: string;
}): string {
  const lines = [
    `${result.original.schedule.length} step(s) -> ${result.minimal.schedule.length} ` +
      `over ${result.runs} run(s), preserving ${result.target.join(", ") || "(nothing)"}`,
  ];
  lines.push(
    result.stop === "1-minimal"
      ? `1-minimal: every remaining edit was tried and none of them still fails.`
      : `NOT minimal (${result.stop}): ${result.note ?? "no reason recorded"}`,
  );
  // Printed even on success. A minimum that preserves the escaping rejection
  // has not been shown to preserve the `ui` finding beside it, and a reader
  // who is not told will assume it has.
  if (result.excludedTarget !== undefined && result.excludedTarget.length > 0) {
    lines.push(
      `not preserved (compares against the model's prediction, not a contract): ` +
        result.excludedTarget.join(", "),
    );
    if (result.stop === "1-minimal" && result.note !== undefined) lines.push(result.note);
  }
  return lines.join("\n");
}

async function runShrink(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "string" },
      url: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      target: { type: "string" },
      "max-runs": { type: "string" },
      retries: { type: "string" },
      "allow-order-sensitive": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help || !values.plan || !values.url || !values.config) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const plan = JSON.parse(readFileSync(resolve(values.plan), "utf8")) as FaultPlan;
  validatePlan(plan);
  const bridge = await loadBridge(values.config);
  const runOptions: RunPlanOptions = {
    ...bridge,
    baseUrl: values.url,
    ...(values["allow-order-sensitive"] ? { allowOrderSensitive: true } : {}),
  };

  // `slow-ok`/`slow-trip` need a solved millisecond value, and a bridge
  // without `appDeadlineMs` has none — the runner throws on such a plan
  // rather than guessing. Both are weaker than `hang`, so without this the
  // first candidate generated for a hang plan would kill the shrink on a
  // bridge that runs `model run` perfectly well.
  const timingAvailable = resolvePlanTiming(runOptions).delays !== undefined;
  const allowOutcomes = timingAvailable
    ? undefined
    : PLAN_OUTCOMES.filter((o) => o !== "slow-ok" && o !== "slow-trip");

  const result = await shrinkPlan({
    plan,
    run: (candidate) => runPlan(candidate, runOptions),
    ...(allowOutcomes !== undefined ? { allowOutcomes } : {}),
    ...(values.target !== undefined ? { target: parseTargetFields(values.target) } : {}),
    ...(values["max-runs"] !== undefined
      ? { maxRuns: positiveInt(values["max-runs"], "--max-runs") }
      : {}),
    ...(values.retries !== undefined ? { retries: nonNegativeInt(values.retries, "--retries") } : {}),
    onStep: (step) =>
      console.error(
        `  run=${step.run} ${step.verdict}${step.kept ? " (kept)" : ""}: ${step.edit}`,
      ),
  });

  if (values.json) {
    // The run log is the audit trail: which candidates were tried, what each
    // one was judged to be, and which were adopted. Without it a `budget`
    // stop is unactionable — you cannot tell whether it was one step from
    // done or had barely started.
    console.log(JSON.stringify({ ...result, report: undefined }, null, 2));
  } else {
    console.log("");
    console.log(formatShrinkResult(result));
  }

  if (values.out) {
    const out = resolve(values.out);
    mkdirSync(resolve(out, ".."), { recursive: true });
    // Named for the file it is written to, so `model run` on the output
    // directory reports it under a name that matches. Keeping the original
    // name would give two different plans the same identity in one report.
    const minimal: FaultPlan = { ...result.minimal, name: stemOf(out) };
    writeFileSync(out, `${JSON.stringify(minimal, null, 2)}\n`);
    if (!values.json) console.log(`minimised plan -> ${values.out}`);
  }

  // A result that is not 1-minimal is a question left open, and a zero exit
  // would let CI treat it as an answer.
  if (!result.converged) process.exitCode = 1;
}

/** Like `positiveInt`, for a flag where 0 is a legitimate choice. */
function nonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`model shrink: ${flag} needs a non-negative integer, got "${raw}"`);
  }
  return n;
}

export async function runModelCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "calibrate":
      await runCalibrate(rest);
      return;
    case "compile":
      await runCompile(rest);
      return;
    case "run":
      await runRun(rest);
      return;
    case "shrink":
      await runShrink(rest);
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
