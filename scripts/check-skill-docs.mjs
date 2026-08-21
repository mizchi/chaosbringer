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
