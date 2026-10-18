#!/usr/bin/env node
/**
 * `chaosbringer recipes <sub>` — operator-grade CLI for the recipe
 * layer (issue #94). Pattern matches `cli.ts`'s existing subcommand
 * convention: one entry function per sub, parsed by `parseArgs`.
 *
 * Supported subs (V1):
 *   list      — print recipes in the store
 *   show      — print one recipe (current or @version)
 *   history   — list a recipe's archived versions
 *   promote   — flip status to "verified"
 *   demote    — flip status to "demoted"
 *   delete    — remove a recipe from the store
 *   prune     — trim a recipe's history
 *   rollback  — restore a historical version
 *   harvest   — read window.__chaosbringer from a URL, upsert results
 *
 * Verify / repair / load-from-store are wired but require a live
 * server / API key so the CLI just forwards options to the
 * programmatic API.
 */

import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { inSubcommand, UsageError } from "../cli-usage.js";
import { weightedRandomDriver } from "../drivers/index.js";
import {
  COMMON_OPTIONS,
  intFlag,
  openStore,
  requireBaseUrl,
  requireRecipe,
  requireVersion,
  warnRebased,
} from "./cli-common.js";
import { diffRecipes, formatRecipeDiff } from "./diff.js";
import { lintRecipe, lintStore, summarise } from "./lint.js";
import { loadPageScenarios } from "./page-scenarios.js";
import { repairRecipe } from "./repair.js";
import { verifyAndPromote, type VerifyResult } from "./verify.js";
import type { ActionRecipe } from "./types.js";
import { errorMessage } from "../errors.js";
import { unreachableNavigation } from "../load/unreachable.js";
import { HEADLESS_OPTIONS, resolveHeadless } from "../cli-headless.js";
import { newIsolatedPage } from "../browser-session.js";

const HELP = `chaosbringer recipes <subcommand> [options]

Subcommands:
  list                List recipes in the store
  show <name>         Print one recipe (use --version N for historical)
  history <name>      List archived versions
  promote <name>      Set status = "verified"
  demote <name>       Set status = "demoted"
  delete <name>       Remove from store (current + history)
  prune <name>        Trim a recipe's history (--keep-last N)
  rollback <name>     Restore a historical version (--to-version N)
  harvest <url>       Read window.__chaosbringer, upsert into store
  verify <name>       Run K verification replays (--runs N --base-url URL)
  diff <name>         Diff two versions (--from-version M --to-version N)
                      or two recipes (\`diff <nameA>..<nameB>\`)
  lint [name]         Lint a recipe (or every recipe when no name given)
  repair <name>       Auto-repair a broken recipe with the AI driver

Common options:
  --dir <path>        Store directory (default: ./chaosbringer-recipes)
  --global            Use global store (~/.chaosbringer/recipes)
  --json              Output JSON (where applicable)
  --quiet             Less output
  --help              Show this help

Each subcommand accepts --help for sub-specific flags.`;

export async function runRecipesCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    return;
  }
  const rest = argv.slice(1);
  const cmd = Object.hasOwn(SUBS, sub) ? SUBS[sub] : undefined;
  if (!cmd) throw new UsageError(`unknown subcommand "${sub}" (expected ${Object.keys(SUBS).join(", ")})`);
  // A usage error names the sub: `chaosbringer recipes show: …`.
  await inSubcommand(`recipes ${sub}`, () => cmd(rest));
}

const SUBS: Record<string, (argv: string[]) => Promise<void>> = {
  list: listCmd,
  show: showCmd,
  history: historyCmd,
  promote: (argv) => statusCmd(argv, "verified"),
  demote: (argv) => statusCmd(argv, "demoted"),
  delete: deleteCmd,
  prune: pruneCmd,
  rollback: rollbackCmd,
  harvest: harvestCmd,
  verify: verifyCmd,
  diff: diffCmd,
  lint: lintCmd,
  repair: repairCmd,
};

// -------- list --------

async function listCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      status: { type: "string" },
      domain: { type: "string" },
      goal: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("recipes list [--status verified|candidate|demoted] [--domain HOST] [--goal NAME]");
    return;
  }
  const store = openStore(values);
  let recipes = values.domain ? store.byDomain(values.domain) : store.list();
  if (values.status) recipes = recipes.filter((r) => r.status === values.status);
  if (values.goal) recipes = recipes.filter((r) => r.goal === values.goal);

  if (values.json) {
    process.stdout.write(JSON.stringify(recipes, null, 2) + "\n");
    return;
  }
  if (recipes.length === 0) {
    console.log("(no recipes match)");
    return;
  }
  console.log(formatTable(recipes));
}

function formatTable(recipes: ReadonlyArray<ActionRecipe>): string {
  const rows = recipes.map((r) => ({
    name: r.name,
    version: `v${r.version}`,
    status: r.status,
    steps: String(r.steps.length),
    succ: String(r.stats.successCount),
    fail: String(r.stats.failCount),
    avg: r.stats.avgDurationMs ? `${Math.round(r.stats.avgDurationMs)}ms` : "—",
    origin: r.origin,
  }));
  const headers = ["name", "version", "status", "steps", "succ", "fail", "avg", "origin"] as const;
  const widths = Object.fromEntries(
    headers.map((h) => [h, Math.max(h.length, ...rows.map((r) => r[h].length))]),
  ) as Record<(typeof headers)[number], number>;
  const line = (cells: Record<(typeof headers)[number], string>): string =>
    headers.map((h) => cells[h].padEnd(widths[h])).join("  ");
  const header = line(
    Object.fromEntries(headers.map((h) => [h, h])) as Record<(typeof headers)[number], string>,
  );
  const sep = headers.map((h) => "-".repeat(widths[h])).join("  ");
  return [header, sep, ...rows.map(line)].join("\n");
}

// -------- show --------

async function showCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      version: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log("recipes show <name> [--version N]");
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const version = intFlag("--version", values.version, 1);
  const store = openStore(values);
  const recipe = version !== undefined ? requireVersion(store, name, version) : requireRecipe(store, name);
  process.stdout.write(JSON.stringify(recipe, null, 2) + "\n");
}

// -------- history --------

async function historyCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: COMMON_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log("recipes history <name>");
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const store = openStore(values);
  const current = requireRecipe(store, name);
  const history = store.history(name);
  const entries = [
    { version: current.version, current: true, steps: current.steps.length, updatedAt: current.updatedAt },
    ...history.map((r) => ({
      version: r.version,
      current: false,
      steps: r.steps.length,
      updatedAt: r.updatedAt,
    })),
  ];
  if (values.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return;
  }
  for (const e of entries) {
    const tag = e.current ? " (current)" : "";
    console.log(
      `v${e.version}${tag}  steps=${e.steps}  updatedAt=${new Date(e.updatedAt).toISOString()}`,
    );
  }
}

// -------- promote / demote --------

async function statusCmd(argv: string[], target: "verified" | "demoted"): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: COMMON_OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log(`recipes ${target === "verified" ? "promote" : "demote"} <name>`);
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const store = openStore(values);
  requireRecipe(store, name);
  store.setStatus(name, target);
  if (!values.quiet) console.log(`${name}: ${target}`);
}

// -------- delete --------

async function deleteCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      force: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log("recipes delete <name> [--force]");
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const store = openStore(values);
  requireRecipe(store, name);
  const history = store.history(name);
  if (history.length > 0 && !values.force) {
    console.error(
      `${name} has ${history.length} archived version(s). Pass --force to delete anyway, or run \`recipes prune --keep-last 0 ${name}\` first.`,
    );
    process.exit(1);
  }
  // Best-effort: also delete archived versions when --force.
  if (values.force) {
    for (const r of history) {
      store.pruneHistory(name, { keepLast: 0 });
      void r;
    }
  }
  store.delete(name);
  if (!values.quiet) console.log(`${name}: deleted`);
}

// -------- prune --------

async function pruneCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      "keep-last": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log("recipes prune <name> [--keep-last N]   (default: 5)");
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const keepLast = intFlag("--keep-last", values["keep-last"], 0) ?? 5;
  const store = openStore(values);
  const deleted = store.pruneHistory(name, { keepLast });
  if (!values.quiet) console.log(`${name}: pruned ${deleted} historical version(s)`);
}

// -------- rollback --------

async function rollbackCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      "to-version": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log("recipes rollback <name> --to-version N");
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  // `Number("")` is 0: a missing --to-version used to ask for v0 and fail
  // as `@v0 not found`, and a non-number printed this usage line and exit 0.
  const toVersion = intFlag("--to-version", values["to-version"], 1);
  if (toVersion === undefined) throw new UsageError("--to-version N is required");
  const store = openStore(values);
  const rolled = store.rollback(name, { toVersion });
  if (!rolled) {
    console.error(`Rollback failed: ${name}@v${toVersion} not found`);
    process.exit(1);
  }
  if (!values.quiet) console.log(`${name}: now at v${rolled.version} (was rollback target v${toVersion})`);
}

// -------- harvest --------

async function harvestCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      trust: { type: "boolean" },
      ...HEADLESS_OPTIONS,
    },
    allowPositionals: true,
    strict: true,
  });
  const url = positionals[0];
  if (values.help) {
    console.log("recipes harvest <url> [--trust]");
    return;
  }
  if (!url) throw new UsageError("expected a URL to harvest");
  const store = openStore(values);
  const browser = await chromium.launch({ headless: resolveHeadless(values) });
  try {
    const { page } = await newIsolatedPage(browser);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const harvested = await loadPageScenarios(page, { trustPublisher: values.trust });
    for (const r of harvested) store.upsert(r);
    if (values.json) {
      process.stdout.write(JSON.stringify(harvested, null, 2) + "\n");
    } else if (harvested.length === 0) {
      console.log("(no scenarios declared at " + url + ")");
    } else {
      console.log(`Harvested ${harvested.length} scenario(s):`);
      for (const r of harvested) {
        console.log(`  ${r.name} (${r.steps.length} steps, ${r.status})`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// -------- verify --------

async function verifyCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      runs: { type: "string" },
      "min-success-rate": { type: "string" },
      "base-url": { type: "string" },
      ...HEADLESS_OPTIONS,
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log(
      "recipes verify <name> --base-url URL [--runs N] [--min-success-rate 0..1]\n\n" +
        "  Replays on --base-url's origin: the recipe's navigations to the origin it\n" +
        "  was recorded on go there instead, path and query kept (with a warning).\n" +
        "  Exit: 0 promoted, 1 not promoted, 2 base URL unreachable — a replay could\n" +
        "  not connect to it, and the recipe's stats and status are left as they were.",
    );
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const baseUrl = values["base-url"];
  if (!baseUrl) throw new UsageError("--base-url is required");
  requireBaseUrl(baseUrl);
  const runs = intFlag("--runs", values.runs, 1) ?? 5;
  const minSuccessRate = values["min-success-rate"] !== undefined ? Number(values["min-success-rate"]) : 0.8;
  if (!(minSuccessRate >= 0 && minSuccessRate <= 1)) {
    throw new UsageError(`--min-success-rate must be a number in 0..1, got ${JSON.stringify(values["min-success-rate"])}`);
  }
  const store = openStore(values);
  const recipe = requireRecipe(store, name);
  if (!values.quiet) warnRebased("verify", [recipe], baseUrl);

  const browser = await chromium.launch({ headless: resolveHeadless(values) });
  try {
    const verifying = verifyAndPromote(store, recipe, {
      runs,
      minSuccessRate,
      baseUrl,
      verbose: !values.quiet,
      setupPage: async () => {
        const { page, close } = await newIsolatedPage(browser);
        // verifyAndPromote does NOT navigate for you — caller's setupPage
        // owns the start state. The recipe's first step (if it's a
        // navigate, rebased onto baseUrl) drives the page; otherwise we
        // go to baseUrl.
        if (recipe.steps[0]?.kind !== "navigate") {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        }
        return { page, cleanup: close };
      },
    });
    const result: VerifyResult = await verifying.catch((err: unknown) => {
      // The goto above meets a host that is down before any replay does.
      // It throws out of verifyAndPromote, which has recorded nothing yet.
      const unreachable = unreachableNavigation(errorMessage(err), baseUrl);
      if (!unreachable) throw err;
      return { promoted: false, demoted: false, successRate: 0, runs, outcomes: [], unreachable };
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (!result.unreachable) {
      console.log(
        `${name}: promoted=${result.promoted} demoted=${result.demoted} rate=${result.successRate.toFixed(2)} (${runs} runs)`,
      );
    }
    if (result.unreachable) {
      console.error(
        `verify: base URL unreachable: ${baseUrl} (${result.unreachable}); ${name} left as it was`,
      );
      process.exitCode = 2;
    } else if (!result.promoted) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

// -------- diff --------

async function diffCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      "from-version": { type: "string" },
      "to-version": { type: "string" },
      context: { type: "string" },
      color: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const target = positionals[0];
  if (values.help) {
    console.log(
      "recipes diff <name> [--from-version M] [--to-version N]\n" +
        "recipes diff <nameA>..<nameB>\n\n" +
        "  Default: --from-version = newest history entry, --to-version = current.\n" +
        "  Use --color for ANSI in tty output.",
    );
    return;
  }
  if (!target) throw new UsageError("expected a recipe name, or <nameA>..<nameB>");
  const fromVersion = intFlag("--from-version", values["from-version"], 1);
  const toVersion = intFlag("--to-version", values["to-version"], 1);
  const context = intFlag("--context", values.context, 0) ?? 1;
  const store = openStore(values);
  const [left, right] = resolveDiffOperands(store, target, { fromVersion, toVersion });
  const diff = diffRecipes(left, right);
  if (values.json) {
    process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
    return;
  }
  if (diff.identical) {
    if (!values.quiet) console.log("(recipes are identical)");
    return;
  }
  const isTty = Boolean(process.stdout.isTTY);
  process.stdout.write(
    formatRecipeDiff(diff, { context, color: values.color ?? isTty }) + "\n",
  );
}

// -------- lint --------

async function lintCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      strict: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    console.log(
      "recipes lint [name] [--strict]\n\n" +
        "  Lints one recipe (when name given) or every recipe in the store.\n" +
        "  Exit code: 1 on any error. With --strict, also 1 on any warning.",
    );
    return;
  }
  const store = openStore(values);
  const target = positionals[0];
  const report = target
    ? summarise(lintRecipe(requireRecipe(store, target), { store }))
    : lintStore(store);
  const issues = report.issues;
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else if (issues.length === 0) {
    if (!values.quiet) console.log("No issues.");
  } else {
    for (const issue of issues) {
      const where = issue.stepIndex !== undefined ? `:step${issue.stepIndex}` : "";
      console.log(
        `${issue.severity.toUpperCase()}  ${issue.recipe}${where}  [${issue.rule}]  ${issue.message}`,
      );
    }
    if (!values.quiet) {
      console.log(
        `\n${report.errorCount} error(s), ${report.warnCount} warning(s), ${report.infoCount} info`,
      );
    }
  }
  if (report.errorCount > 0) process.exitCode = 1;
  else if (values.strict && report.warnCount > 0) process.exitCode = 1;
}

// -------- repair --------

async function repairCmd(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...COMMON_OPTIONS,
      "base-url": { type: "string" },
      "start-url": { type: "string" },
      "repair-budget": { type: "string" },
      seed: { type: "string" },
      ...HEADLESS_OPTIONS,
    },
    allowPositionals: true,
    strict: true,
  });
  const name = positionals[0];
  if (values.help) {
    console.log(
      "recipes repair <name> --base-url URL [--start-url URL] [--repair-budget N] [--seed N]\n\n" +
        "  Uses the weighted-random driver to discover a working tail after the\n" +
        "  failing step. For LLM-driven repair, call repairRecipe() programmatically\n" +
        "  with `driver: aiDriver(...)` instead. With --base-url, the recipe replays\n" +
        "  on that origin, as `recipes verify` does, and the repaired version keeps it.",
    );
    return;
  }
  if (!name) throw new UsageError("expected a recipe name");
  const seed = intFlag("--seed", values.seed, 0);
  const budget = intFlag("--repair-budget", values["repair-budget"], 1);
  const store = openStore(values);
  const recipe = requireRecipe(store, name);
  const baseUrl = values["base-url"];
  const startUrl = values["start-url"];
  if (!baseUrl && !startUrl && recipe.steps[0]?.kind !== "navigate") {
    throw new UsageError("--base-url (or --start-url) is required when the recipe does not start with a navigate step");
  }
  if (baseUrl) {
    requireBaseUrl(baseUrl);
    if (!values.quiet) warnRebased("repair", [recipe], baseUrl);
  }
  const browser = await chromium.launch({ headless: resolveHeadless(values) });
  try {
    const result = await repairRecipe({
      recipe,
      store,
      driver: weightedRandomDriver(),
      browser,
      baseUrl,
      startUrl,
      repairBudget: budget,
      seed,
      verbose: !values.quiet,
    });
    if (values.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.repaired) {
      console.log(
        `${name}: repaired — kept ${result.failedAt} prefix step(s), added ${result.newTailSteps} new tail step(s), now at v${result.recipe!.version}`,
      );
    } else {
      console.log(
        `${name}: NOT repaired — failedAt step ${result.failedAt}, driver added ${result.newTailSteps} step(s) but didn't satisfy postconditions`,
      );
    }
    if (!result.repaired) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

// -------- helpers --------

function resolveDiffOperands(
  store: ReturnType<typeof openStore>,
  target: string,
  opts: { fromVersion?: number; toVersion?: number },
): [ActionRecipe, ActionRecipe] {
  if (target.includes("..")) {
    const [a, b] = target.split("..", 2);
    return [requireRecipe(store, a!), requireRecipe(store, b!)];
  }
  const current = requireRecipe(store, target);
  const history = store.history(target);
  const toVersion = opts.toVersion ?? current.version;
  const fromVersion = opts.fromVersion ?? history[0]?.version;
  if (fromVersion === undefined) {
    console.error(
      `${target}: no history to diff against — pass --from-version, or use the \`name..other\` form`,
    );
    process.exit(1);
  }
  return [
    requireVersion(store, target, fromVersion),
    requireVersion(store, target, toVersion),
  ];
}
