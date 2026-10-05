/**
 * `chaosbringer drive --url <url> --goal "<goal>"`: operate a browser
 * towards a goal and report what broke on the way. See `drive()`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HEADLESS_OPTIONS, resolveHeadless } from "../cli-headless.js";
import { RecipeStore } from "../recipes/store.js";
import { anthropicDecider, openRouterDecider, planDecider, type DrivePlanStep } from "./deciders.js";
import { drive, type DriveDecider, type DriveResult, type DriveUntil } from "./drive.js";

const HELP = `
chaosbringer drive — operate a browser towards a goal, with the checks running

USAGE:
  chaosbringer drive --url <url> --goal "<what to do>" [options]

Each step, a model reads the page as Playwright's accessibility snapshot sees
it (every control numbered, with its state and where it sits) and answers with
one action: click, fill a field with text it chose, select an option, press a
key, or done. While it drives, uncaught exceptions, unhandled rejections,
console errors, failed requests and 5xx answers are collected step by step and
shown to the model. A run that reaches its goal is written as a recipe that
\`chaosbringer recipes\` can verify and replay.

OPTIONS:
  --url <url>               Start page (required)
  --goal <text>             What to achieve (required)
  --until-url <text>        Success: the URL contains this
  --until-url-matches <re>  Success: the URL matches this regex
  --until-text <text>       Success: the page shows this text
                            (without an --until-*, the model's "done" ends the run, unverified)
  --provider <name>         anthropic | openrouter (default: whichever of
                            ANTHROPIC_API_KEY / OPENROUTER_API_KEY is set)
  --model <id>              Model id (default: claude-haiku-4-5-20251001 / google/gemini-2.5-flash)
  --vision                  Also send a screenshot each step
  --plan <file.json>        No model: follow a plan of steps instead, e.g.
                            [{"click":"link \\"Sign in\\""},{"fill":"textbox \\"Email\\"","value":"a@b.test"}]
                            ("/.../" strings are regexes on the control descriptions)
  --max-steps <n>           Actions at most (default 20)
  --exclude <regex>         Never reach these URLs (repeatable), e.g. "/logout"
  --video <path.webm>       Record the run, every action annotated
  --out <dir>               Write drive-report.json (and recipe.json) here
  --save-recipe [name]      Store the recipe of a successful run in the recipe store
  --dir <path>              Recipe store directory (default ./chaosbringer-recipes)
  --storage-state <path>    Playwright storageState to start logged in
  --no-headless             Show the browser
  --quiet                   Only print the summary
  --help                    Show this help

Exit code: 0 when the goal was reached (or the model said done), 1 otherwise.
Only drive sites you own or are allowed to test.
`;

export async function runDriveCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      "until-url": { type: "string" },
      "until-url-matches": { type: "string" },
      "until-text": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      vision: { type: "boolean", default: false },
      plan: { type: "string" },
      "max-steps": { type: "string" },
      exclude: { type: "string", multiple: true },
      video: { type: "string" },
      out: { type: "string" },
      "save-recipe": { type: "string" },
      dir: { type: "string" },
      "storage-state": { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      ...HEADLESS_OPTIONS,
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.url || !values.goal) {
    console.error("drive: --url and --goal are required (see --help)");
    process.exitCode = 2;
    return;
  }

  const decider = values.plan ? planFrom(values.plan) : modelDecider(values.provider, values.model, values.vision ?? false);
  const until: DriveUntil = {
    ...(values["until-url"] ? { urlIncludes: values["until-url"] } : {}),
    ...(values["until-url-matches"] ? { urlMatches: values["until-url-matches"] } : {}),
    ...(values["until-text"] ? { text: values["until-text"] } : {}),
  };
  const quiet = values.quiet ?? false;
  const result = await drive({
    url: values.url,
    goal: values.goal,
    decider,
    ...(Object.keys(until).length > 0 ? { until } : {}),
    ...(values["max-steps"] ? { maxSteps: positiveInt(values["max-steps"], "--max-steps") } : {}),
    ...(values.exclude ? { excludePatterns: values.exclude } : {}),
    ...(values.video ? { video: values.video } : {}),
    ...(values["storage-state"] ? { contextOptions: { storageState: values["storage-state"] } } : {}),
    ...(values["save-recipe"] ? { recipeName: values["save-recipe"] } : {}),
    headless: resolveHeadless(values),
    onStep: quiet
      ? undefined
      : (s, d) => {
          const what = [s.action, s.target, s.value !== undefined ? JSON.stringify(s.value) : undefined].filter(Boolean).join(" ");
          console.log(`[drive] ${s.step}. ${what} — ${s.ok ? "ok" : `failed: ${s.error}`}`);
          if (d.reasoning) console.log(`        ${d.reasoning}`);
          for (const p of s.problems) console.log(`        ! ${p}`);
        },
  });

  console.log(formatDriveSummary(result));
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, "drive-report.json"), JSON.stringify(result, null, 2));
    if (result.recipe) writeFileSync(join(values.out, "recipe.json"), JSON.stringify(result.recipe, null, 2));
  }
  if (values["save-recipe"] !== undefined) {
    if (result.recipe) {
      const store = new RecipeStore({ localDir: values.dir ?? join(process.cwd(), "chaosbringer-recipes"), globalDir: false });
      store.upsert(result.recipe);
      console.log(`recipe saved: ${result.recipe.name} (verify with: chaosbringer recipes verify ${result.recipe.name})`);
    } else {
      console.log(`no recipe saved: ${result.recipeSkipped ?? "the goal was not reached"}`);
    }
  }
  if (result.status !== "reached" && result.status !== "done") process.exitCode = 1;
}

export function formatDriveSummary(r: DriveResult): string {
  const lines = [
    `drive: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`,
    `  ${r.steps.length} step(s), ${(r.durationMs / 1000).toFixed(1)}s, decider ${r.decider}, ended at ${r.finalUrl}`,
  ];
  if (r.problems.length > 0) {
    lines.push(`  ${r.problems.length} problem(s) seen:`);
    for (const p of r.problems.slice(0, 15)) lines.push(`    [${p.step < 0 ? "load" : `step ${p.step}`}] ${p.kind}: ${p.message.slice(0, 160)}`);
    if (r.problems.length > 15) lines.push(`    … ${r.problems.length - 15} more`);
  } else {
    lines.push("  no problems seen");
  }
  if (r.video) lines.push(`  video: ${r.video}`);
  if (r.recipe) lines.push(`  recipe: ${r.recipe.name} (${r.recipe.steps.length} steps)`);
  else if (r.recipeSkipped) lines.push(`  no recipe: ${r.recipeSkipped}`);
  return lines.join("\n");
}

function modelDecider(provider: string | undefined, model: string | undefined, vision: boolean): DriveDecider {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const which = provider ?? (anthropicKey ? "anthropic" : openRouterKey ? "openrouter" : undefined);
  const common = { ...(model ? { model } : {}), vision };
  if (which === "anthropic") {
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");
    return anthropicDecider({ apiKey: anthropicKey, ...common });
  }
  if (which === "openrouter") {
    if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is not set");
    return openRouterDecider({ apiKey: openRouterKey, ...common });
  }
  if (which !== undefined) throw new Error(`unknown --provider ${which} (anthropic | openrouter)`);
  throw new Error("no model: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or pass --plan <file.json>");
}

/** A plan file: `DrivePlanStep`s, with `"/re/flags"` strings read as regexes. */
export function planFrom(path: string): DriveDecider {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`--plan ${path}: expected a JSON array of steps`);
  const pattern = (v: unknown): string | RegExp => {
    if (typeof v !== "string") throw new Error(`--plan ${path}: a step's target must be a string`);
    const m = /^\/(.+)\/([a-z]*)$/.exec(v);
    return m ? new RegExp(m[1]!, m[2]) : v;
  };
  const steps = raw.map((s: Record<string, unknown>, i): DrivePlanStep => {
    if ("click" in s) return { click: pattern(s.click) };
    if ("fill" in s && typeof s.value === "string") return { fill: pattern(s.fill), value: s.value, ...(s.submit === true ? { submit: true } : {}) };
    if ("select" in s && typeof s.value === "string") return { select: pattern(s.select), value: s.value };
    if ("press" in s && typeof s.press === "string") return { press: s.press, ...(s.on !== undefined ? { on: pattern(s.on) } : {}) };
    throw new Error(`--plan ${path}: step ${i} is not click / fill+value / select+value / press`);
  });
  return planDecider(steps, `plan:${path}`);
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}
