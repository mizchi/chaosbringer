#!/usr/bin/env node
/**
 * Static checks over every code block in the chaosbringer skill.
 *
 * Not a substitute for running the snippets — three of them are executed
 * against the eval app by `verify-snippet.mjs` / `verify-harness.mjs` — but the
 * cheap failures are the ones that keep recurring across eval runs: a named
 * export that does not exist, a `faults.*` helper that was never shipped, a
 * signature written the wrong way round. Those are all decidable from the
 * package's own exports without launching anything.
 *
 * Usage: `pnpm check:skill-docs` (from the repo root).
 *
 * That script runs it through `pnpm -F chaosbringer exec tsx`, rather than a
 * bare `tsx`, because `tsx` is a dependency of that package and only reaches
 * the root `node_modules/.bin` by way of `node-linker=hoisted` in `.npmrc`. A
 * bare invocation works today and breaks as "command not found" the day that
 * setting changes — and a lint step that cannot run looks exactly like one
 * that passes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const skillDir =
  process.argv[2] ?? new URL("../.claude/skills/chaosbringer", import.meta.url).pathname;
// Import the package's *source*, not its build. `dist/` is gitignored and can
// be stale or mid-rebuild, and a checker that reports real exports as missing
// because of that is worse than no checker. Run under tsx.
const pkgEntry = new URL("../packages/chaosbringer/src/index.ts", import.meta.url);
const mod = await import(pkgEntry.href).catch((err) => {
  console.error(
    `cannot import ${pkgEntry.pathname} — run this with tsx ` +
      `(\`pnpm check:skill-docs\`).\n${err.message}`,
  );
  process.exit(2);
});
const exported = new Set(Object.keys(mod));
// The runtime's own list of legal option names, imported rather than restated:
// a second copy here would drift, and the copy the checker used would be the
// one nobody fixed.
const { KNOWN_OPTION_NAMES } = await import(
  new URL("../packages/chaosbringer/src/crawler.ts", import.meta.url).href
);
const faultHelpers = new Set(Object.keys(mod.faults ?? {}));

const files = ["SKILL.md", ...readdirSync(join(skillDir, "references")).map((f) => `references/${f}`)];
const problems = [];
let checkedIdentifiers = 0;

for (const rel of files) {
  const text = readFileSync(join(skillDir, rel), "utf8");
  const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
    .filter(([, lang]) => lang === "ts" || lang === "js");

  for (const [, , body] of blocks) {
    // Every `import { a, b } from "chaosbringer"` must name real exports.
    for (const m of body.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']chaosbringer["']/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (!name) continue;
        checkedIdentifiers++;
        if (!exported.has(name)) problems.push(`${rel}: imports "${name}", which the package root does not export`);
      }
    }
    // Every `faults.x(` must be a real helper.
    for (const m of body.matchAll(/faults\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)) {
      checkedIdentifiers++;
      if (!faultHelpers.has(m[1])) problems.push(`${rel}: uses faults.${m[1]}(), which does not exist`);
    }
    // `faults.status` takes the status first; the object-only form was shipped
    // in a docstring once and cost somebody time.
    for (const m of body.matchAll(/faults\.status\(\s*\{/g)) {
      problems.push(`${rel}: faults.status({...}) — the status is the first argument: faults.status(500, {...})`);
    }
  }
}

// The CLI has no fault-injection flag, and a doc that implies otherwise sends a
// reader to a monkey-clicker that comes back green. Cheap to keep honest: the
// flags are declared in one place.
const cliHelp = readFileSync(
  new URL("../packages/chaosbringer/src/cli.ts", import.meta.url),
  "utf8",
);
// Every flag any CLI entry point declares — the root one and each subcommand,
// since `chaosbringer model calibrate --runs 3` is parsed by `model/cli.ts`.
// The union is deliberately loose: the failure worth catching is an invented
// flag that appears in no parser at all.
const cliDir = new URL("../packages/chaosbringer/src/", import.meta.url).pathname;
const cliSources = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(join(dir, entry.name));
    else if (/cli\.ts$/.test(entry.name)) cliSources.push(readFileSync(join(dir, entry.name), "utf8"));
  }
};
collect(cliDir);
const cliFlags = new Set(["--no-headless", "--help"]);
for (const src of cliSources) {
  for (const m of src.matchAll(/["']?([a-z][a-z0-9-]*)["']?:\s*\{\s*type:\s*["'](?:string|boolean)["']/g)) {
    cliFlags.add(`--${m[1]}`);
  }
}
for (const rel of files) {
  const text = readFileSync(join(skillDir, rel), "utf8");
  // Inline code AND fenced blocks: CLI invocations live in ```bash fences, and
  // the first version of this check only scanned backticks — so it passed a
  // deliberately-planted `--fault-500` and was a guard that could not fail.
  const candidates = [
    ...[...text.matchAll(/`([^`\n]*chaosbringer [^`\n]*)`/g)].map((m) => m[1]),
    ...[...text.matchAll(/```(?:bash|sh|console)?\n([\s\S]*?)```/g)]
      .flatMap(([, body]) => body.split("\n"))
      .filter((line) => /chaosbringer /.test(line)),
  ];
  for (const line of candidates) {
    for (const flag of line.match(/--[a-z][a-z0-9-]*/g) ?? []) {
      if (!cliFlags.has(flag)) {
        problems.push(`${rel}: \`${line.trim()}\` uses ${flag}, which the CLI does not accept`);
      }
    }
  }
}

// Crawler option names. `maxActions` is not an option: JavaScript accepts it,
// ignores it, and the run then fails as "my fault never fired" — the hardest
// thing in this library to debug. A wrong option *in the docs* propagates that
// to every reader, so the names the docs hand out are checked against the same
// list the runtime near-miss guard uses.
const optionNames = new Set(KNOWN_OPTION_NAMES);
// Keys `chaos()` layers on top of CrawlerOptions, plus the bridge options of
// `runPlan`, which appear in the same object-literal shape.
const alsoValid = new Set([
  "setup", "teardown", "rules", "action", "uiProbe", "stateProbe", "uiInvariants",
  "settleMs", "quiescenceMs", "asyncDrainCapMs", "checkAmplification", "plansDir",
  "allowOrderSensitive", "timingProfile", "appDeadlineMs", "coverageFingerprints",
]);
for (const rel of files) {
  const text = readFileSync(join(skillDir, rel), "utf8");
  const blocks = [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
    .filter(([, lang]) => lang === "ts" || lang === "js");
  for (const [, , body] of blocks) {
    // `new ChaosCrawler({`, `chaos({`, `runPlan(plan, {` — the option literal
    // runs to the matching close, which a regex cannot find, so take the keys
    // at the literal's own indentation depth and stop at the first dedent.
    for (const m of body.matchAll(/(?:new ChaosCrawler|chaos|runPlan)\s*\([^{]*\{\n([\s\S]*?)\n(?=\S|\}\))/g)) {
      const lines = m[1].split("\n");
      const indent = (lines[0].match(/^\s*/) ?? [""])[0];
      for (const line of lines) {
        if (!line.startsWith(indent) || line.slice(indent.length).startsWith(" ")) continue;
        const key = line.slice(indent.length).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
        if (!key) continue;
        checkedIdentifiers++;
        if (!optionNames.has(key[1]) && !alsoValid.has(key[1])) {
          problems.push(
            `${rel}: documents option "${key[1]}", which is not a CrawlerOptions key — ` +
              `a misspelled option is accepted and ignored, and fails as "my fault never fired"`,
          );
        }
      }
    }
  }
}

// And the session surface the docs promise.
const SESSION_METHODS = ["stats", "runtimeStats", "firings", "heldRequests", "release", "dispose"];
const apiText = readFileSync(join(skillDir, "references/api.md"), "utf8");
for (const name of SESSION_METHODS) {
  if (!apiText.includes("`" + name + "()`")) problems.push(`references/api.md: session method ${name}() is undocumented`);
}

console.log(`checked ${checkedIdentifiers} identifiers across ${files.length} files`);
if (problems.length > 0) {
  for (const p of problems) console.log("  FAIL " + p);
  process.exit(1);
}
console.log("every documented import, fault helper and session method exists");
