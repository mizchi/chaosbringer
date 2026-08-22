#!/usr/bin/env node
/**
 * Every workflow must parse as YAML, and every `run:` block in it must parse as
 * shell.
 *
 * Two bugs, one shape. `flaker-confirm.yml` shipped its only real step as a
 * bash syntax error — `\$(seq …)` and `\\` continuations, escaped for a quoting
 * layer a YAML block scalar does not have. It is dispatch-only, so nothing ever
 * ran it, and a flakiness-confirmation tool that cannot run looks exactly like
 * one nobody has needed yet.
 *
 * Then the first version of this script had the same problem one level up. It
 * read workflows with regexes, so when a step name in `ci.yml` was written as
 * `name: Check workflow run: blocks parse as shell` — an unquoted scalar
 * containing `: `, which YAML reads as a nested mapping and rejects — GitHub
 * silently stopped running the whole file (`build-and-test`, `adversarial` and
 * every `example-tests` job vanished from the PR) while this script cheerfully
 * reported "checked 64 run: blocks". A checker that passes a file the runner
 * cannot load is worse than no checker.
 *
 * So the YAML is parsed, not pattern-matched: a parse failure is the first
 * thing reported, and the `run:` blocks are read off the parsed tree rather
 * than guessed at from indentation.
 *
 * Usage: `pnpm check:workflow-shell` (from the repo root).
 */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

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
let parsed = 0;

/** Every `run:` string anywhere in the tree, with a path for the message. */
function collectRuns(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectRuns(v, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "run" && typeof value === "string") {
      out.push({ path: `${path}.run`, script: value, name: node.name });
    } else {
      collectRuns(value, `${path}.${key}`, out);
    }
  }
}

for (const file of files) {
  const text = readFileSync(join(dir, file), "utf8");
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    // Reported and skipped: there is no tree to walk, and "0 shell problems"
    // in a file GitHub refuses to load is the reassuring lie this exists to
    // prevent.
    problems.push(
      `${file}: does not parse as YAML, so GitHub will not run it at all\n    ${String(err.message).split("\n")[0]}`,
    );
    continue;
  }
  parsed++;
  const runs = [];
  collectRuns(doc, "", runs);
  for (const { path, script, name } of runs) {
    // GitHub expands `${{ … }}` before the shell sees it, and `${{` is not
    // valid bash. A quoted expression becomes a quoted word, so quoting is
    // preserved by the substitution.
    const shell = script.replace(/\$\{\{[^}]*\}\}/g, "GHEXPR");
    blocks++;
    const tmp = join(scratch, `${file.replace(/\W/g, "_")}-${blocks}.sh`);
    writeFileSync(tmp, shell);
    try {
      execFileSync("bash", ["-n", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const msg = String(err.stderr ?? err.message).replaceAll(tmp, file).trim();
      problems.push(
        `${file}: \`run:\` at ${path}${name ? ` ("${name}")` : ""} is not valid shell\n    ${msg}`,
      );
    }
  }
}

console.log(`parsed ${parsed}/${files.length} workflow files, checked ${blocks} run: blocks`);
if (problems.length > 0) {
  for (const p of problems) console.log("  FAIL " + p);
  process.exit(1);
}
console.log("every workflow parses as YAML and every run: block parses as shell");
