#!/usr/bin/env node
/**
 * Which `contract-forbids-*` targets could ever have come back reachable?
 *
 *   node patterns/vacuity.mjs                      # every pattern, report only
 *   node patterns/vacuity.mjs token-refresh        # one pattern
 *   node patterns/vacuity.mjs token-refresh --annotate   # …and rewrite targets.txt
 *
 * Every `enumerate.sh` ends with a block whose comment says "a witness here
 * means the SPEC is wrong", and each of those lines lands in `targets.txt` as
 * `unreachable <name>` — indistinguishable from its neighbours and costing
 * ~14s of Apalache and a JVM. But a target is only a *result* if the model
 * could have produced a witness. These models are written as "set every knob
 * to what a correct implementation must do, then the forbidden states are
 * unreachable", so the test is mechanical: invert the boolean contract knobs
 * and ask again.
 *
 *   unreachable-live               a knob setting produces a witness. The
 *                                  checker could have said either thing, so
 *                                  "unreachable" is a verification result.
 *   unreachable-by-construction    no setting of any knob can. The predicate
 *                                  is an identity of the model's own
 *                                  arithmetic — `not(attempts <= MAX)` where
 *                                  the only assignment is
 *                                  `if (spent) attempts else attempts + 1` —
 *                                  and no model checker was needed to learn
 *                                  it. Either give the model the knob that
 *                                  makes the property falsifiable, or drop
 *                                  the query and say why in the model header.
 *
 * `quint run --witnesses` answers it in ~2s per model with no JVM, which is why
 * this is cheap enough for `enumerate.sh` to call on every regeneration rather
 * than being a thing someone remembers to do.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const QUINT = process.env.QUINT_PKG ?? "@informalsystems/quint@0.32.0";
const SAMPLES = process.env.SAMPLES ?? "400";

/**
 * Model unit → its directory and spec file, **discovered** rather than listed.
 *
 * A hand-maintained list was the first version of this, and it lasted exactly
 * until the next pattern: a unit nobody added is a unit nobody classifies, and
 * an unclassified target looks the same as a checked one — which is the finding
 * this script exists for. The depth still comes from each unit's own
 * `enumerate.sh`, so the two cannot drift apart. `../model` is the 4x4
 * tutorial, which has contract-forbids targets for the same reason.
 */
function discoverModels() {
  const out = {};
  for (const dir of ["../model", ...readdirSync(here, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()]) {
    const abs = join(here, dir);
    if (!existsSync(join(abs, "enumerate.sh"))) continue;
    const specs = readdirSync(abs).filter((f) => f.endsWith(".qnt"));
    if (specs.length !== 1) {
      // Zero or several: the convention is one spec per unit, and guessing
      // which one would be worse than saying so.
      console.error(
        `vacuity: ${dir} has ${specs.length} .qnt files, expected exactly one — skipping`,
      );
      continue;
    }
    out[dir === "../model" ? "model" : dir] = { dir, file: specs[0] };
  }
  return out;
}

const MODELS = discoverModels();

const args = process.argv.slice(2);
const annotate = args.includes("--annotate");
const picked = args.filter((a) => !a.startsWith("--"));
const patterns = picked.length > 0 ? picked : Object.keys(MODELS);
const scratch = mkdtempSync(join(tmpdir(), "vacuity-"));

/** The `emit "<name>" "<predicate>"` lines of a pattern's own enumerate.sh. */
function targetsOf(dir) {
  const src = readFileSync(join(dir, "enumerate.sh"), "utf8");
  const out = [];
  for (const line of src.split("\n")) {
    const m = /^emit\s+"([^"]+)"\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    let pred = m[2].trim().replace(/\s*\\$/, "");
    if (pred.startsWith("'") && pred.endsWith("'")) pred = pred.slice(1, -1);
    else if (pred.startsWith('"') && pred.endsWith('"')) pred = pred.slice(1, -1);
    out.push({ name: m[1], pred: pred.replace(/\\"/g, '"') });
  }
  return out;
}

/** DEPTH from the pattern's own enumerate.sh, so the two agree by construction. */
function depthOf(dir) {
  const m = /DEPTH="\$\{DEPTH:-(\d+)\}"/.exec(readFileSync(join(dir, "enumerate.sh"), "utf8"));
  return m ? m[1] : "5";
}

const knobsOf = (src) => [...src.matchAll(/pure val (\w+) = (?:true|false)/g)].map((m) => m[1]);

const flipKnobs = (src) =>
  src.replace(
    /pure val (\w+) = (true|false)/g,
    (_all, name, value) => `pure val ${name} = ${value === "true" ? "false" : "true"}`,
  );

function witnesses(file, depth, preds) {
  if (preds.length === 0) return {};
  const out = execFileSync(
    "npx",
    [
      "--yes",
      QUINT,
      "run",
      file,
      "--backend=typescript",
      `--max-samples=${SAMPLES}`,
      `--max-steps=${depth}`,
      "--seed=0x1",
      ...preds.flatMap((p) => ["--witnesses", p]),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const hits = Object.fromEntries(preds.map((p) => [p, 0]));
  for (const line of out.split("\n")) {
    const m = /^(.*) was witnessed in (\d+) trace\(s\)/.exec(line.trim());
    if (m && m[1] in hits) hits[m[1]] = Number(m[2]);
  }
  return hits;
}

/** Every assignment to `v` in the model, as written — the argument, not the verdict. */
const assignmentsTo = (src, v) =>
  [...src.matchAll(new RegExp(`${v}'\\s*=\\s*([^,\\n]+)`, "g"))].map((m) => m[1].trim());

const varNames = (src) => [...src.matchAll(/^\s*var (\w+):/gm)].map((m) => m[1]);

/** A predicate may name a `val` that mentions the variable (e.g. noPhantomRows). */
function predUsesVia(src, pred, v) {
  for (const m of src.matchAll(/^\s*val (\w+) =([\s\S]*?)$/gm)) {
    if (pred.includes(m[1]) && new RegExp(`\\b${v}\\b`).test(m[2])) return true;
  }
  return false;
}

/** Rewrite `unreachable  <name>` into the classified form, in place. */
function annotateTargets(dir, verdicts) {
  const path = join(dir, "targets.txt");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out = lines.map((line) => {
    // `<verdict> <name> [the rest, which some units keep]`.
    const m = /^(unreachable\S*)\s+(\S+)(.*)$/.exec(line);
    if (!m) return line;
    const verdict = verdicts.get(m[2]);
    if (verdict === undefined) return line;
    const word = verdict ? "unreachable-live" : "unreachable-by-construction";
    return `${word.padEnd(27)} ${m[2]}${m[3]}`;
  });
  writeFileSync(path, out.join("\n"));
}

let live = 0;
const vacuous = [];

for (const pattern of patterns) {
  const unit = MODELS[pattern];
  if (unit === undefined) {
    console.error(`vacuity: unknown unit "${pattern}". Known: ${Object.keys(MODELS).join(", ")}`);
    process.exitCode = 2;
    continue;
  }
  const { file } = unit;
  const dir = join(here, unit.dir);
  const src = readFileSync(join(dir, file), "utf8");
  const depth = depthOf(dir);
  const flipped = join(scratch, `flipped-${file}`);
  writeFileSync(flipped, flipKnobs(src));

  const targets = targetsOf(dir).filter((t) => t.name.startsWith("contract-forbids-"));
  const preds = targets.map((t) => t.pred);
  const asIs = witnesses(join(dir, file), depth, preds);
  const flip = witnesses(flipped, depth, preds);

  console.log(`\n=== ${pattern}/${file}`);
  console.log(
    `    boolean contract knobs: ${knobsOf(src).join(", ") || "(none)"}` +
      `   (${SAMPLES} random traces, depth ${depth})`,
  );
  const verdicts = new Map();
  for (const t of targets) {
    const a = asIs[t.pred];
    const b = flip[t.pred];
    verdicts.set(t.name, b > 0);
    if (b > 0) live += 1;
    else vacuous.push(`${pattern}/${t.name}`);
    console.log(
      `    ${(b > 0 ? "LIVE" : "BY CONSTRUCTION").padEnd(15)} ${t.name.padEnd(34)} ` +
        `shipped=${a} knobs-flipped=${b}   [${t.pred}]`,
    );
    if (b === 0) {
      // Say *why* no knob can reach it: every assignment to the variables the
      // predicate names. That is the actual argument.
      for (const v of varNames(src)) {
        if (!new RegExp(`\\b${v}\\b`).test(t.pred) && !predUsesVia(src, t.pred, v)) continue;
        console.log(`                      ${v}' ∈ { ${[...new Set(assignmentsTo(src, v))].join(" | ")} }`);
      }
    }
  }
  if (annotate) {
    annotateTargets(dir, verdicts);
    console.log(`    annotated ${pattern}/targets.txt`);
  }
}

const total = live + vacuous.length;
console.log(
  `\nSUMMARY  ${live} of ${total} contract-forbids target(s) live (a knob setting produces a ` +
    `witness)` +
    (vacuous.length > 0
      ? `; ${vacuous.length} unreachable by construction:\n${vacuous.map((v) => `  - ${v}`).join("\n")}`
      : ""),
);
