/**
 * `chaosbringer drive --url <url> --goal "<goal>"`: operate a browser
 * towards a goal and report what broke on the way. See `drive()`.
 */

import { accessSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { HEADLESS_OPTIONS, resolveHeadless } from "../cli-headless.js";
import { UsageError } from "../cli-usage.js";
import { errorMessage } from "../errors.js";
import { checkInputFiles, readInputJson } from "../input-files.js";
import { recipeOrigin } from "../recipes/replay.js";
import { RecipeStore } from "../recipes/store.js";
import { type RecipeVars, templateNames, VARIABLE_NAME_RE } from "../recipes/templating.js";
import type { ActionRecipe } from "../recipes/types.js";
import { shellQuote } from "../repro-command.js";
import { anthropicDecider, openRouterDecider, planDecider, type DrivePlanStep } from "./deciders.js";
import { drive, type DriveDecider, type DriveResult, type DriveUntil } from "./drive.js";
import { siteProblems } from "./problems.js";
import { attachHint, type BoundBrowser, waitForInterrupt } from "../browser-bind.js";
import { recipeChaos, type RecipeChaosResult } from "./chaos.js";
import { SCAN_FAULT_KINDS, type ScanFaultKind } from "../scan/analyze.js";

/** Where `--save-recipe` stores without `--dir`; `recipes`' default too. */
const DEFAULT_RECIPE_DIR = "chaosbringer-recipes";

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
                            (without an --until-*, the model's "done" ends the run, unverified;
                            with one, 3 answers in a row that act on nothing, or a --plan that
                            ran out before it held, end the run as stuck)
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
  --secret <name>=<ENV>     A secret typed by name (repeatable): a --plan value (or a model's
                            fill) of {{name}} types the value of environment variable ENV.
                            It must be set and not empty
  --save-secrets <file>     Write the secrets the recipe needs to <file> (JSON, mode 0600), for
                            \`recipes verify --vars-file <file>\`. Overwrites a regular file;
                            refuses a directory, a symlink or one it cannot write
  --storage-state <path>    Playwright storageState to start logged in
  --bind                    Serve the browser to other Playwright clients while driving:
                            npx playwright cli attach <title>, or an MCP client with
                            npx playwright mcp --endpoint <endpoint> (printed at start)
  --bind-title <title>      Name to attach by (default chaosbringer)
  --keep-open               After the run, keep the browser open until Ctrl-C (with --bind:
                            an agent can look at the final state or take over)
  --chaos                   After a run that reached its goal, replay its recipe with the
                            app's own API calls failing (each fault in --faults).
                            Reports what escaped uncaught, a goal shown as reached with
                            the API down, and where the journey stops
  --faults <list>           Faults for --chaos: 500,abort,hang (default all three)
  --hang-ms <ms>            How long the hang fault holds a request (default 8000)
  --no-headless             Show the browser
  --quiet                   Only print the summary
  --help                    Show this help

SECRETS:
  What drive types into a password field (type=password, autocomplete *-password) or a
  one-time-code field, and every --secret, is recorded as a placeholder: {{password}}
  ({{password_2}} for a second, different value), {{one_time_code}}, or the --secret's name.
  The value is replaced by that placeholder in what drive prints, drive-report.json,
  recipe.json, the recipe store, the video's action titles and what the model is shown.
  It is not taken out of what the app itself sends or logs, nor out of screenshots or video
  frames of a field the page does not mask (a one-time code shows as typed).

Exit code: 0 when the goal was reached (or the model said done), 1 otherwise,
2 when it refuses to start (no --url or --goal, no model, a bad value, a
--plan or --storage-state file that is missing or does not parse, a --plan
value with a {{name}} no --secret names, a --secret whose variable is unset,
a --save-secrets path it cannot write).
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
      secret: { type: "string", multiple: true },
      "save-secrets": { type: "string" },
      chaos: { type: "boolean", default: false },
      bind: { type: "boolean", default: false },
      "bind-title": { type: "string" },
      "keep-open": { type: "boolean", default: false },
      faults: { type: "string" },
      "hang-ms": { type: "string" },
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
  if (!values.url || !values.goal) throw new UsageError("--url and --goal are required");
  // Parsed before the drive, not when --chaos replays after it: a typo in
  // --faults or --hang-ms was found only once the whole drive had run.
  const maxSteps = values["max-steps"] ? positiveInt(values["max-steps"], "--max-steps") : undefined;
  const faults = values.chaos ? parseFaults(values.faults ?? "all") : undefined;
  const hangReleaseMs = values["hang-ms"] ? positiveInt(values["hang-ms"], "--hang-ms") : undefined;
  // Read before the browser starts: a missing one failed inside Playwright
  // as `drive failed: …` and exit 1, which is "the goal was not reached".
  checkInputFiles({ storageState: values["storage-state"] });
  const secrets = parseSecretFlags(values.secret ?? [], process.env);
  if (values["save-secrets"] !== undefined) checkSecretsPath(values["save-secrets"]);

  const decider = values.plan
    ? planFrom(values.plan, new Set(Object.keys(secrets)))
    : modelDecider(values.provider, values.model, values.vision ?? false);
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
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(values.exclude ? { excludePatterns: values.exclude } : {}),
    ...(values.video ? { video: values.video } : {}),
    ...(values["storage-state"] ? { contextOptions: { storageState: values["storage-state"] } } : {}),
    ...(values["save-recipe"] ? { recipeName: values["save-recipe"] } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    headless: resolveHeadless(values),
    ...(values.bind || values["bind-title"] ? { bind: values["bind-title"] ?? true, onBind: (b: BoundBrowser) => console.log(attachHint(b)) } : {}),
    ...(values["keep-open"]
      ? {
          keepOpen: async (r: DriveResult) => {
            console.log(`drive: ${r.status}; the browser stays open at ${r.finalUrl}. Ctrl-C to close.`);
            await waitForInterrupt();
          },
        }
      : {}),
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
  // The values the recipe's placeholders need, and only those.
  const needed: RecipeVars = Object.fromEntries(
    Object.entries(result.secretValues()).filter(([name]) => result.variables.includes(name)),
  );
  let secretsFile: string | undefined;
  if (values["save-secrets"] !== undefined) {
    if (result.recipe) {
      writeSecretsFile(values["save-secrets"], needed);
      secretsFile = values["save-secrets"];
      console.log(`secrets saved: ${secretsFile} (${result.variables.length > 0 ? result.variables.join(", ") : "none needed"}; mode 0600)`);
    } else {
      console.log(`no secrets saved: ${result.recipeSkipped ?? "the goal was not reached"}`);
    }
  }
  if (values["save-recipe"] !== undefined) {
    if (result.recipe) {
      const store = new RecipeStore({ localDir: values.dir ?? join(process.cwd(), DEFAULT_RECIPE_DIR), globalDir: false });
      store.upsert(result.recipe);
      console.log(
        `recipe saved: ${result.recipe.name} (verify with: ${verifyCommand(result.recipe, values.dir, { variables: result.variables, varsFile: secretsFile })})`,
      );
      if (result.variables.length > 0 && secretsFile === undefined) {
        console.log(
          `  the recipe types ${result.variables.map((n) => `{{${n}}}`).join(", ")}: give each value with --var, or pass --save-secrets <file> to drive to write a --vars-file`,
        );
      }
    } else {
      console.log(`no recipe saved: ${result.recipeSkipped ?? "the goal was not reached"}`);
    }
  }
  let chaos: RecipeChaosResult | undefined;
  if (faults) {
    if (!result.recipe) {
      console.log(`chaos replay skipped: ${result.recipeSkipped ?? "the goal was not reached"}`);
    } else {
      console.log(`[chaos] replaying ${result.recipe.name} clean, then with ${faults.join(", ")}`);
      chaos = await recipeChaos({
        recipe: result.recipe,
        ...(Object.keys(until).length > 0 ? { until } : {}),
        faults,
        vars: result.secretValues(),
        ...(values.exclude ? { exclude: values.exclude } : {}),
        ...(hangReleaseMs !== undefined ? { hangReleaseMs } : {}),
        ...(values["storage-state"] ? { contextOptions: { storageState: values["storage-state"] } } : {}),
        headless: resolveHeadless(values),
        onRun: quiet
          ? undefined
          : (r) => console.log(`[chaos] ${r.label}: steps ${r.replay.ok ? "ran" : `stopped at ${r.replay.failedAt?.index}`}, goal ${r.goalHeld === null ? "?" : r.goalHeld ? "held" : "not held"}, fault fired ${r.fired}×, ${r.newProblems.length} new problem(s)`),
      });
      console.log(formatChaosSummary(chaos));
      if (values.out) writeFileSync(join(values.out, "chaos-report.json"), JSON.stringify(chaos, null, 2));
    }
  }
  if (result.status !== "reached" && result.status !== "done") process.exitCode = 1;
  else if (chaos?.findings.some((f) => f.severity === "high")) process.exitCode = 1;
}

/**
 * The `recipes verify` command for a recipe `drive` just stored. verify
 * requires `--base-url`: the origin the recipe was recorded on, which a
 * reader swaps for another host to verify it there. `--dir` only when
 * the store is not verify's default, which it would not find otherwise.
 * A recipe with placeholders (`variables`) needs their values: the
 * `--vars-file` drive wrote them to, or else a `--var NAME=VALUE` for each,
 * VALUE for the reader to fill in (verify refuses to run without them).
 */
export function verifyCommand(
  recipe: ActionRecipe,
  dir: string | undefined,
  vars: { variables?: readonly string[]; varsFile?: string } = {},
): string {
  const words = ["chaosbringer", "recipes", "verify", shellQuote(recipe.name)];
  const origin = recipeOrigin(recipe);
  if (origin) words.push("--base-url", shellQuote(origin));
  if (dir !== undefined && resolve(dir) !== resolve(DEFAULT_RECIPE_DIR)) words.push("--dir", shellQuote(dir));
  if (vars.varsFile !== undefined) words.push("--vars-file", shellQuote(vars.varsFile));
  else for (const name of vars.variables ?? []) words.push("--var", `${name}=VALUE`);
  return words.join(" ");
}

/**
 * `--secret name=ENV_VAR` flags as the `secrets` `drive()` types by name.
 * A `UsageError` naming the flag for a pair that is not `name=ENV_VAR`, a
 * name a placeholder cannot use, a name given twice, or a variable that is
 * unset or empty: refused before the browser starts, not typed as nothing.
 */
export function parseSecretFlags(flags: readonly string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    const name = flag.slice(0, eq);
    const variable = flag.slice(eq + 1);
    if (eq <= 0 || variable === "") throw new UsageError(`--secret ${JSON.stringify(flag)}: expected NAME=ENV_VAR`);
    if (!VARIABLE_NAME_RE.test(name)) {
      throw new UsageError(`--secret ${JSON.stringify(flag)}: ${JSON.stringify(name)} is not a variable name (letters, digits, _ . -, starting with a letter or _)`);
    }
    if (Object.hasOwn(out, name)) throw new UsageError(`--secret ${JSON.stringify(flag)}: ${name} is given twice`);
    const value = env[variable];
    if (value === undefined) throw new UsageError(`--secret ${JSON.stringify(flag)}: environment variable ${variable} is not set`);
    if (value === "") throw new UsageError(`--secret ${JSON.stringify(flag)}: environment variable ${variable} is empty`);
    out[name] = value;
  }
  return out;
}

/**
 * A `UsageError` unless `--save-secrets` can be written once the run is
 * over: a path that does not exist (its directory is created), or a regular
 * file this process can write, which is overwritten. A directory, a symlink
 * (writing through it would put the secrets wherever it points) or anything
 * else is refused before the browser starts.
 */
export function checkSecretsPath(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return;
    throw new UsageError(`--save-secrets ${path}: cannot be checked (${errorMessage(err)})`);
  }
  if (st.isSymbolicLink()) throw new UsageError(`--save-secrets ${path}: is a symlink; give the file itself`);
  if (!st.isFile()) throw new UsageError(`--save-secrets ${path}: exists and is not a regular file`);
  try {
    accessSync(path, constants.W_OK);
  } catch {
    throw new UsageError(`--save-secrets ${path}: exists and cannot be written`);
  }
}

/**
 * Write `vars` to `path` as JSON readable by its owner only. The mode is
 * set before anything is written, also on a file that already existed with
 * a wider one (`open`'s mode only applies to a file it creates).
 */
export function writeSecretsFile(path: string, vars: RecipeVars): void {
  checkSecretsPath(path);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const fd = openSync(path, "w", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(vars, null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
}

export function formatChaosSummary(c: RecipeChaosResult): string {
  if (c.skipped) return `chaos: skipped — ${c.skipped}`;
  const lines = [`chaos: ${c.findings.length} finding(s) over ${c.endpoints.length || "the given"} endpoint(s)${c.endpoints.length ? `: ${c.endpoints.map((e) => e.label).join(", ")}` : ""}`];
  const icon = { high: "🔴", medium: "🟠", low: "🟡" };
  for (const f of c.findings) {
    lines.push(`  ${icon[f.severity]} ${f.title}`);
    for (const d of f.detail.slice(0, 3)) lines.push(`      ${d}`);
  }
  return lines.join("\n");
}

function parseFaults(v: string): ScanFaultKind[] {
  if (v === "" || v === "all") return [...SCAN_FAULT_KINDS];
  const names: Record<string, ScanFaultKind> = { "500": "status", status: "status", abort: "abort", hang: "hang" };
  return v.split(",").map((f) => {
    const k = names[f.trim()];
    if (!k) throw new UsageError(`--faults: unknown fault ${f} (500, abort, hang)`);
    return k;
  });
}

export function formatDriveSummary(r: DriveResult): string {
  const lines = [
    `drive: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`,
    `  ${r.steps.length} step(s), ${(r.durationMs / 1000).toFixed(1)}s, decider ${r.decider}, ended at ${r.finalUrl}`,
  ];
  const site = siteProblems(r.problems);
  if (site.length > 0) {
    lines.push(`  ${site.length} problem(s) seen:`);
    for (const p of site.slice(0, 15)) lines.push(`    [${p.step < 0 ? "load" : `step ${p.step}`}] ${p.kind}: ${p.message.slice(0, 160)}`);
    if (site.length > 15) lines.push(`    … ${site.length - 15} more`);
  } else {
    lines.push("  no problems seen");
  }
  const env = r.problems.length - site.length;
  if (env > 0) {
    const reasons = [...new Set(r.problems.flatMap((p) => (p.environment ? [p.environment] : [])))];
    lines.push(`  ${env} error(s) caused by this machine, not the site: ${reasons.join("; ")}`);
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
  // Refused before a browser starts, like a missing --url: nothing ran.
  if (which === "anthropic") {
    if (!anthropicKey) throw new UsageError("ANTHROPIC_API_KEY is not set");
    return anthropicDecider({ apiKey: anthropicKey, ...common });
  }
  if (which === "openrouter") {
    if (!openRouterKey) throw new UsageError("OPENROUTER_API_KEY is not set");
    return openRouterDecider({ apiKey: openRouterKey, ...common });
  }
  if (which !== undefined) throw new UsageError(`unknown --provider ${which} (anthropic | openrouter)`);
  throw new UsageError("no model: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or pass --plan <file.json>");
}

/**
 * A plan file: `DrivePlanStep`s, with `"/re/flags"` strings read as regexes.
 * Anything wrong with it is a `UsageError` naming `--plan` (exit 2): as a
 * plain Error it was `drive failed: …` and exit 1, "the goal was not reached".
 */
export function planFrom(path: string, secrets: ReadonlySet<string> = new Set()): DriveDecider {
  const raw = readInputJson("--plan", path, "plan");
  if (!Array.isArray(raw)) throw new UsageError(`--plan ${path}: expected a JSON array of steps`);
  const pattern = (v: unknown, i: number): string | RegExp => {
    if (typeof v !== "string") throw new UsageError(`--plan ${path}: step ${i}'s target must be a string`);
    const m = /^\/(.+)\/([a-z]*)$/.exec(v);
    if (!m) return v;
    try {
      return new RegExp(m[1]!, m[2]);
    } catch (err) {
      throw new UsageError(`--plan ${path}: step ${i}'s target ${JSON.stringify(v)} is not a valid regex (${errorMessage(err)})`);
    }
  };
  // A `{{name}}` in a value is a secret's placeholder: one no --secret
  // names would fail its step, after the steps before it had run.
  const value = (v: string, i: number): string => {
    const unknown = templateNames(v).filter((n) => !secrets.has(n));
    if (unknown.length > 0) {
      throw new UsageError(
        `--plan ${path}: step ${i}'s value uses {{${unknown[0]}}}, which no --secret names (add --secret ${unknown[0]}=ENV_VAR)`,
      );
    }
    return v;
  };
  const steps = raw.map((s: unknown, i): DrivePlanStep => {
    if (typeof s !== "object" || s === null) throw new UsageError(`--plan ${path}: step ${i} is not an object`);
    const step = s as Record<string, unknown>;
    if ("click" in step) return { click: pattern(step.click, i) };
    if ("fill" in step && typeof step.value === "string") return { fill: pattern(step.fill, i), value: value(step.value, i), ...(step.submit === true ? { submit: true } : {}) };
    if ("select" in step && typeof step.value === "string") return { select: pattern(step.select, i), value: value(step.value, i) };
    if ("press" in step && typeof step.press === "string") return { press: step.press, ...(step.on !== undefined ? { on: pattern(step.on, i) } : {}) };
    throw new UsageError(`--plan ${path}: step ${i} is not click / fill+value / select+value / press`);
  });
  return planDecider(steps, `plan:${path}`);
}

function positiveInt(v: string, flag: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer (got ${JSON.stringify(v)})`);
  return n;
}
