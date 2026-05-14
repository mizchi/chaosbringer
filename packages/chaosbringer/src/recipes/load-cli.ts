#!/usr/bin/env node
/**
 * `chaosbringer load --from-store` — convenience CLI that wires
 * `scenarioLoadFromStore` to the terminal. The programmatic API is
 * still the right call when you need fault injection, custom SLOs,
 * or invariants; the CLI is the "I just want N workers replaying my
 * verified recipes for K minutes" path.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatLoadReport, parseDurationMs, type DurationInput } from "../load/index.js";
import {
  isRecipeSelection,
  isRecipeStatus,
  openStore,
  RECIPE_SELECTIONS,
  RECIPE_STATUSES,
} from "./cli-common.js";
import { scenarioLoadFromStore, type RecipeSelection } from "./load-bridge.js";
import type { RecipeStatus } from "./types.js";

const HELP = `chaosbringer load --base-url URL [options]

Options:
  --base-url URL          (required) base URL the load run hits
  --workers N             concurrent virtual users (default: 5)
  --duration D            run length, e.g. 30s, 2m (default: 60s)
  --ramp-up D             linear ramp-up window (default: 0)
  --think-time MIN-MAX    per-step think time range in ms (e.g. "100-500")
  --selection MODE        uniform | by-success-rate (default: uniform)
  --filter-status STATUS  verified (default) | candidate | demoted
  --max-iterations N      hard cap on iterations per worker (default: unbounded)
  --dir PATH              local store directory (default: ./chaosbringer-recipes)
  --global                use global store (~/.chaosbringer/recipes)
  --output PATH           write the JSON report here (default: stdout-only)
  --no-headless           show browser windows
  --quiet                 minimal output
  --json                  print the full report as JSON instead of the summary
  --help

The runner picks one verified recipe per iteration, replays it (with
\`requires\` chain resolution), and aggregates step / iteration / network
samples. For chaos faults or SLO gating, use scenarioLoadFromStore()
programmatically.`;

interface ParsedArgs {
  baseUrl: string;
  workers: number;
  duration: DurationInput;
  rampUp?: DurationInput;
  thinkTime?: { minMs: number; maxMs: number };
  selection: RecipeSelection;
  filterStatus: RecipeStatus;
  maxIterations?: number;
  store: ReturnType<typeof openStore>;
  output?: string;
  headless: boolean;
  quiet: boolean;
  json: boolean;
}

export async function runLoadCli(argv: string[]): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }
  const parsed = parseFlags(argv);
  if (!parsed) return;
  const result = await scenarioLoadFromStore({
    baseUrl: parsed.baseUrl,
    workers: parsed.workers,
    duration: parsed.duration,
    rampUp: parsed.rampUp,
    headless: parsed.headless,
    maxIterationsPerWorker: parsed.maxIterations,
    selection: parsed.selection,
    filter: (r) => r.status === parsed.filterStatus,
    store: parsed.store,
    thinkTime: parsed.thinkTime,
  });
  if (parsed.output) {
    writeFileSync(parsed.output, JSON.stringify(result, null, 2));
  }
  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (!parsed.quiet) {
    console.log(formatLoadReport(result.report));
    if (result.recipes.length > 0) {
      console.log("\nRecipe firings:");
      for (const r of result.recipes) {
        const rate = r.fired > 0 ? ((r.succeeded / r.fired) * 100).toFixed(1) : "0.0";
        console.log(
          `  ${r.name.padEnd(40)} fired=${r.fired} succ=${r.succeeded} fail=${r.failed} rate=${rate}% avg=${Math.round(r.avgDurationMs)}ms`,
        );
      }
    }
  }
  const failed =
    result.report.totals.iterationFailures > 0 || result.report.totals.stepFailures > 0;
  if (failed) process.exitCode = 1;
}

function parseFlags(argv: string[]): ParsedArgs | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      "base-url": { type: "string" },
      workers: { type: "string" },
      duration: { type: "string" },
      "ramp-up": { type: "string" },
      "think-time": { type: "string" },
      selection: { type: "string" },
      "filter-status": { type: "string" },
      "max-iterations": { type: "string" },
      dir: { type: "string" },
      global: { type: "boolean" },
      output: { type: "string" },
      "no-headless": { type: "boolean" },
      headless: { type: "boolean" },
      quiet: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return null;
  }
  const baseUrl = values["base-url"];
  if (!baseUrl) {
    console.error("load: --base-url is required\n");
    console.error(HELP);
    process.exit(2);
  }
  const workers = parsePositiveInt("--workers", values.workers, 5);
  // Validate at the CLI boundary so a typo in --duration / --ramp-up
  // fails before launching Chromium, with the bad input echoed.
  const duration = validateDuration("--duration", values.duration ?? "60s");
  const rampUp = values["ramp-up"]
    ? validateDuration("--ramp-up", values["ramp-up"])
    : undefined;
  const filterStatusRaw = values["filter-status"] ?? "verified";
  if (!isRecipeStatus(filterStatusRaw)) {
    console.error(`load: --filter-status must be ${RECIPE_STATUSES.join("|")}`);
    process.exit(2);
  }
  const selectionStr = values.selection ?? "uniform";
  if (!isRecipeSelection(selectionStr)) {
    console.error(`load: --selection must be ${RECIPE_SELECTIONS.join("|")}`);
    process.exit(2);
  }
  const store = openStore({
    dir: values.dir,
    global: values.global,
    quiet: values.quiet,
  });
  const thinkTime = parseThinkTime(values["think-time"]);
  // --no-headless wins over --headless when both pass through.
  const headless = values["no-headless"] ? false : values.headless !== false;
  return {
    baseUrl,
    workers,
    duration,
    rampUp,
    thinkTime,
    selection: selectionStr,
    filterStatus: filterStatusRaw,
    maxIterations: values["max-iterations"]
      ? parsePositiveInt("--max-iterations", values["max-iterations"])
      : undefined,
    store,
    output: values.output,
    headless,
    quiet: Boolean(values.quiet),
    json: Boolean(values.json),
  };
}

function parsePositiveInt(flag: string, raw: string | undefined, fallback?: number): number {
  if (raw === undefined) {
    if (fallback === undefined) {
      console.error(`load: ${flag} is required`);
      process.exit(2);
    }
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`load: ${flag} must be a positive integer, got ${raw}`);
    process.exit(2);
  }
  return n;
}

function validateDuration(flag: string, raw: string): DurationInput {
  try {
    parseDurationMs(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`load: ${flag} invalid (${detail})`);
    process.exit(2);
  }
  return raw as DurationInput;
}

/**
 * Accept `MIN-MAX` where each side is a duration parseable by
 * `parseDurationMs` — so `100-500`, `100ms-500ms`, and `100ms-2s` all
 * work. Matches the rest of the load CLI's duration vocabulary.
 */
function parseThinkTime(raw: string | undefined): { minMs: number; maxMs: number } | undefined {
  if (!raw) return undefined;
  const idx = raw.indexOf("-");
  if (idx <= 0) {
    console.error(`load: --think-time must be MIN-MAX, got ${raw}`);
    process.exit(2);
  }
  try {
    const minMs = parseDurationMs(raw.slice(0, idx));
    const maxMs = parseDurationMs(raw.slice(idx + 1));
    if (maxMs < minMs) {
      console.error(`load: --think-time max (${maxMs}ms) is below min (${minMs}ms)`);
      process.exit(2);
    }
    return { minMs, maxMs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`load: --think-time invalid (${detail})`);
    process.exit(2);
  }
}
