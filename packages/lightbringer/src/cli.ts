#!/usr/bin/env node
// lightbringer CLI — measure a scenario with zero spec/setup.
//
//   npx lightbringer run scenario.json [flags]
//
// scenario.json: { url, viewport?, settle?, steps: [{ name, goto?, click?, fill?,
//   text?, drag?, by?, press?, waitFor?, wait?, settle? }] }
// Each step becomes one measured span. Flags below; --emit-budgets writes a budget
// file from the measured medians and --gate fails against it (no hand-set numbers).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type BrowserContextOptions } from "playwright";
import {
  startSession,
  logSummary,
  emitBudgets,
  formatGateViolation,
  gate,
  spanMedians,
  type PerfReport,
  type SpanMedians,
} from "./core";
import { RUN_REPORT_RE, runArtifactPath, slugOfRunReport, slugify } from "./artifacts";
import { sessionOptionsFromEnv, toSessionOptions } from "./config";
import { netProfileByName } from "./defaults";

interface Step {
  name: string;
  goto?: string;
  click?: string;
  fill?: string;
  text?: string;
  drag?: string;
  by?: [number, number];
  press?: string;
  waitFor?: string;
  wait?: number;
  settle?: SettleSpec;
}
interface Scenario {
  url: string;
  viewport?: { width: number; height: number };
  settle?: SettleSpec;
  steps: Step[];
}
type SettleSpec = "networkidle" | "load" | "raf" | number;

// ── arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv[0] !== "run" || !argv[1]) {
  console.error(
    "usage: lightbringer run <scenario.json | existing-spec.ts> [--repeat N] [--out DIR]\n" +
      "       (a .json runs a declarative scenario; anything else runs an existing\n" +
      "        Playwright spec via `playwright test` + the repo's own config)\n" +
      "       [--gpu] [--cpu N] [--net slow-3g|fast-3g|4g] [--cov] [--mem] [--css]\n" +
      "       [--trace] [--headed] [--emit-budgets] [--gate]",
  );
  process.exit(1);
}
const scenarioPath = argv[1];
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const opt = (name: string, def?: string) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

const repeat = Math.max(1, Number(opt("repeat", "1")));
const outDir = path.resolve(opt("out", "perf-results")!);
const cpuRate = Number(opt("cpu", "1"));
const netName = opt("net");
const gpu = flags.has("--gpu");
const headed = flags.has("--headed");
const cov = flags.has("--cov");
const mem = flags.has("--mem");
const css = flags.has("--css");
const trace = flags.has("--trace") || css;
const emitBudgetsFlag = flags.has("--emit-budgets");
const gateFlag = flags.has("--gate");

const netProfile = netProfileByName(netName);
// Flags drive the CLI; PERF_* env vars still supply what has no flag
// (PERF_SETTLE_TIMEOUT), exactly as before.
const envOpts = sessionOptionsFromEnv();

// A .json argument is a declarative scenario; anything else (a .ts/.js test file
// or glob) is an existing Playwright spec, run via `playwright test` with the auto
// loader and the repo's own config.
const isSpec = !scenarioPath.endsWith(".json");

// ── scenario ────────────────────────────────────────────────────────────────
const scenario: Scenario = isSpec
  ? { url: "", steps: [] }
  : JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const slug = slugify(path.basename(scenarioPath).replace(/\.(json|[tj]s)$/, ""));

function settleFn(spec: SettleSpec | undefined) {
  const s = spec ?? scenario.settle ?? "networkidle";
  if (s === "raf") return undefined; // use the library default (2 rAF)
  if (typeof s === "number") return (p: Page) => p.waitForTimeout(s);
  return (p: Page) => p.waitForLoadState(s).catch(() => {});
}

async function applyStep(page: Page, step: Step) {
  if (step.goto != null) await page.goto(new URL(step.goto, scenario.url).href);
  if (step.fill != null) await page.fill(step.fill, step.text ?? "");
  if (step.click != null) await page.click(step.click, { timeout: 8000 });
  if (step.press != null) await page.keyboard.press(step.press);
  if (step.drag != null) {
    const box = await page.locator(step.drag).first().boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const [dx, dy] = step.by ?? [-200, -150];
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
      await page.mouse.up();
    }
  }
  if (step.waitFor != null) await page.locator(step.waitFor).first().waitFor({ timeout: 15000 });
  if (step.wait != null) await page.waitForTimeout(step.wait);
}

async function runOnce(index: number): Promise<PerfReport> {
  const browser = await chromium.launch({
    headless: !headed,
    args: gpu ? ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"] : [],
  });
  try {
    const ctxOpts: BrowserContextOptions = scenario.viewport ? { viewport: scenario.viewport } : {};
    const context = await browser.newContext(ctxOpts);
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    fs.mkdirSync(outDir, { recursive: true });
    const runTag = `run${index}`;
    const tracePath = runArtifactPath(outDir, slug, runTag, "trace");
    const session = await startSession(
      page,
      client,
      toSessionOptions(
        {
          cpuRate,
          netProfile,
          coverage: cov,
          memGc: mem,
          cssStats: css,
          trace,
          settleTimeoutMs: envOpts.settleTimeoutMs,
        },
        tracePath,
      ),
    );
    for (const step of scenario.steps) {
      await session.controller.measure(step.name, () => applyStep(page, step), {
        settle: settleFn(step.settle),
      });
    }
    const { report, covArtifact } = await session.finish(scenario.url);
    fs.writeFileSync(runArtifactPath(outDir, slug, runTag, "report"), JSON.stringify(report, null, 2));
    if (covArtifact)
      fs.writeFileSync(runArtifactPath(outDir, slug, runTag, "coverage"), JSON.stringify(covArtifact));
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

// ── median + budgets ──────────────────────────────────────────────────────
// Medians, ×1.25 budgets and the gate come from src/stats.ts, the same
// functions scripts/median.mjs and chaosbringer's `perf` subcommands use.

/** slug → span → metric → budget (lightbringer.budgets.json) */
type SlugBudgets = Record<string, SpanMedians>;

/** Read the per-run report files written by the run (scenario or spec). */
function loadRunsBySlug(): Map<string, PerfReport[]> {
  const m = new Map<string, PerfReport[]>();
  if (!fs.existsSync(outDir)) return m;
  for (const f of fs.readdirSync(outDir)) {
    if (!RUN_REPORT_RE.test(f) || f.includes(".coverage.") || f.includes(".trace.")) continue;
    const s = slugOfRunReport(f);
    const r = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8")) as PerfReport;
    (m.get(s) ?? m.set(s, []).get(s)!).push(r);
  }
  return m;
}

/** Emit budgets from medians (×1.25) and/or gate against them. Keyed slug→span→metric. */
function emitOrGate(bySlug: Map<string, PerfReport[]>) {
  const budgetsPath = path.join(outDir, "lightbringer.budgets.json");
  if (emitBudgetsFlag) {
    const budgets: SlugBudgets = {};
    for (const [s, runs] of bySlug) budgets[s] = emitBudgets(spanMedians(runs));
    fs.writeFileSync(budgetsPath, JSON.stringify(budgets, null, 2));
    console.log(`\n[lightbringer] wrote budgets → ${path.relative(process.cwd(), budgetsPath)} (median ×1.25)`);
  }
  if (gateFlag) {
    if (!fs.existsSync(budgetsPath)) {
      console.error(`[lightbringer] --gate: no budgets at ${budgetsPath} (run --emit-budgets first)`);
      process.exit(1);
    }
    const budgets = JSON.parse(fs.readFileSync(budgetsPath, "utf8")) as SlugBudgets;
    const violations: string[] = [];
    for (const [s, runs] of bySlug) {
      // Bare medians (no IQR band), so this gate has hard violations only.
      const r = gate(spanMedians(runs), budgets[s] ?? {});
      violations.push(...r.violations.map((f) => formatGateViolation(s, f)));
    }
    if (violations.length) {
      console.error(`\n[lightbringer] GATE FAILED (${violations.length}):`);
      for (const v of violations) console.error(`  ✗ ${v}`);
      process.exit(1);
    }
    console.log(`\n[lightbringer] gate passed.`);
  }
}

/** Spec mode: run an existing Playwright spec with the auto loader + the repo's config. */
function runSpecMode() {
  const hookPath = fileURLToPath(new URL("../scripts/pw-hook.mjs", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Point at autowrap.js (type-only on @playwright/test), NOT auto.js (which
    // value-imports it) — else the loader pulls a 2nd Playwright instance next to
    // the project's and Playwright aborts ("required from two locations").
    LIGHTBRINGER_AUTO_WRAP: new URL("./autowrap.js", import.meta.url).href,
    PERF_OUT_DIR: outDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${hookPath}`.trim(),
  };
  if (cpuRate > 1) env.PERF_CPU = String(cpuRate);
  if (mem) env.PERF_MEM = "1";
  if (cov) env.PERF_COV = "1";
  if (css) env.PERF_CSS = "1";
  if (trace) env.PERF_TRACE = "1";
  if (gpu) env.PERF_GPU = "1";
  if (netName) env.PERF_NET = netName;
  const args = ["playwright", "test", scenarioPath];
  const cfg = opt("config");
  if (cfg) args.push("--config", cfg);
  if (repeat > 1) args.push(`--repeat-each=${repeat}`);
  process.stderr.write(`[lightbringer] npx ${args.join(" ")}\n`);
  const res = spawnSync("npx", args, { stdio: "inherit", env });
  if (res.status) process.exit(res.status);
}

async function main() {
  if (isSpec) {
    runSpecMode(); // auto fixture logs each test + writes perf-results/*.json
    if (emitBudgetsFlag || gateFlag) emitOrGate(loadRunsBySlug());
    return;
  }
  const runs: PerfReport[] = [];
  for (let i = 0; i < repeat; i++) {
    process.stderr.write(`[lightbringer] run ${i + 1}/${repeat}\n`);
    runs.push(await runOnce(i));
  }
  logSummary(runs[runs.length - 1]!, mem);
  if (emitBudgetsFlag || gateFlag) emitOrGate(new Map([[slug, runs]]));
}

main().catch((e) => {
  if (String(e).includes("Executable doesn't exist") || String(e).includes("playwright install")) {
    console.error("[lightbringer] Chromium not installed. Run: npx playwright install chromium");
  } else {
    console.error(e);
  }
  process.exit(1);
});
