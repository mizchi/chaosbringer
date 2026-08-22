#!/usr/bin/env node
/**
 * `bash -n` over every `run:` block in `.github/workflows`.
 *
 * `flaker-confirm.yml` shipped its only real step as a bash syntax error — the
 * command was written with `\$(seq …)` and `\\` line continuations, escaped for
 * a quoting layer that a YAML block scalar does not have. It is dispatch-only,
 * so nothing ever ran it, and a flakiness-confirmation tool that cannot run
 * looks exactly like one nobody has needed yet.
 *
 * Nothing checked workflow shell, which is the same gap as the CLI flags in
 * `check-skill-docs`: the code is verified and the thing that invokes it is not.
 *
 * Usage: `pnpm check:workflow-shell` (from the repo root).
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = new URL("../.github/workflows/", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
if (files.length === 0) {
  // A checker that finds nothing to check is the defect it is here to prevent.
  console.error("no workflow files under .github/workflows — this check ran on nothing");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "wf-shell-"));
const problems = [];
let blocks = 0;

for (const file of files) {
  const lines = readFileSync(join(dir, file), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    // `run: |` or `run: >` starts a block scalar; `run: cmd` is one line.
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$/);
    if (!m) continue;
    const [, indent, scalar, inline] = m;
    let body;
    let startLine = i + 1;
    if (scalar) {
      const out = [];
      // The block ends at the first line that is neither blank nor indented
      // deeper than the `run:` key itself.
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") { out.push(""); continue; }
        const lead = line.match(/^\s*/)[0].length;
        if (lead <= indent.length) break;
        out.push(line);
        i = j;
      }
      // Strip the common indent so heredocs and continuations line up.
      const deepest = Math.min(
        ...out.filter((l) => l.trim() !== "").map((l) => l.match(/^\s*/)[0].length),
      );
      body = out.map((l) => l.slice(deepest)).join("\n");
    } else {
      if (inline.trim() === "") continue;
      body = inline;
    }
    // GitHub expressions are substituted before the shell ever sees them, and
    // `${{` is not valid bash. Replace each with a plain word so what is left
    // is the shell the runner would actually execute. A quoted expression
    // becomes a quoted word, so quoting is preserved.
    const shell = body.replace(/\$\{\{[^}]*\}\}/g, "GHEXPR");
    blocks++;
    const path = join(scratch, `${file.replace(/\W/g, "_")}-${startLine}.sh`);
    writeFileSync(path, shell);
    try {
      execFileSync("bash", ["-n", path], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const msg = String(err.stderr ?? err.message)
        .replaceAll(path, `${file}:${startLine}`)
        .trim();
      problems.push(`${file}: \`run:\` block at line ${startLine} is not valid shell\n    ${msg}`);
    }
  }
}

console.log(`checked ${blocks} run: blocks across ${files.length} workflow files`);
if (problems.length > 0) {
  for (const p of problems) console.log("  FAIL " + p);
  process.exit(1);
}
console.log("every workflow run: block parses as shell");
