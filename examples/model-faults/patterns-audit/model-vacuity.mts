/**
 * F6 — which `contract-forbids-*` targets are a proof and which are an
 * arithmetic identity.
 *
 *   cd examples/model-faults && npx tsx patterns-audit/model-vacuity.mts
 *
 * Every pattern's `enumerate.sh` ends with a block of targets whose comment
 * says: "The states the contract forbids. A witness here means the SPEC is
 * wrong." Those lines land in `targets.txt` as `unreachable <name>`, next to the
 * reachable ones, and they read as verification results — each one cost a
 * ~14s Apalache query.
 *
 * A target is only a result if the model *could* have produced a witness. The
 * design of these models is "set every knob to what a correct implementation
 * must do, then a forbidden state must be unreachable" — so the test is whether
 * flipping the knobs makes it reachable. If no setting of any knob can, the
 * checker was asked a question with one possible answer.
 *
 * The classification below is mechanical:
 *
 *   1. the targets are parsed out of the pattern's own `enumerate.sh`;
 *   2. `quint run` counts witnesses over N random traces for the shipped model
 *      and for a copy with every boolean contract knob inverted;
 *   3. for a target that stays at zero either way, every assignment to the
 *      variables it names is printed — a variable whose only assignment is
 *      `x' = x`, over an `init` that sets it false, is false in every reachable
 *      state by induction, and no model checker was needed to learn that.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const patternsDir = join(here, "..", "patterns");
// Knob-inverted copies go to a temp dir: nothing is written into the repo.
const scratch = mkdtempSync(join(tmpdir(), "patterns-audit-"));

const QUINT = ["--yes", "@informalsystems/quint@0.32.0"];
const SAMPLES = process.env.SAMPLES ?? "400";

interface Model {
  pattern: string;
  file: string;
  depth: string;
}

const MODELS: Model[] = [
  { pattern: "retry-idempotency", file: "retry.qnt", depth: "4" },
  { pattern: "token-refresh", file: "token.qnt", depth: "5" },
  { pattern: "timeout-ladder", file: "ladder.qnt", depth: "3" },
  { pattern: "optimistic-rollback", file: "rollback.qnt", depth: "4" },
  { pattern: "pagination-order", file: "feed.qnt", depth: "5" },
  { pattern: "reconnect-budget", file: "reconnect.qnt", depth: "5" },
];

/** The `emit "<name>" "<predicate>"` lines of a pattern's own enumerate.sh. */
function targetsOf(pattern: string): Array<{ name: string; pred: string }> {
  const src = readFileSync(join(patternsDir, pattern, "enumerate.sh"), "utf8");
  const out: Array<{ name: string; pred: string }> = [];
  for (const line of src.split("\n")) {
    const m = /^emit\s+"([^"]+)"\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    let pred = m[2]!.trim();
    if (pred.startsWith("'") && pred.endsWith("'")) pred = pred.slice(1, -1);
    else if (pred.startsWith('"') && pred.endsWith('"')) pred = pred.slice(1, -1);
    out.push({ name: m[1]!, pred: pred.replace(/\\"/g, '"') });
  }
  return out;
}

/** Every `pure val NAME = true|false` knob in the model. */
function knobsOf(src: string): string[] {
  return [...src.matchAll(/pure val (\w+) = (?:true|false)/g)].map((m) => m[1]!);
}

function flipKnobs(src: string): string {
  return src.replace(
    /pure val (\w+) = (true|false)/g,
    (_all, name, value) => `pure val ${name} = ${value === "true" ? "false" : "true"}`,
  );
}

function witnesses(file: string, depth: string, preds: string[]): Record<string, number> {
  const args = [
    ...QUINT,
    "run",
    file,
    "--backend=typescript",
    `--max-samples=${SAMPLES}`,
    `--max-steps=${depth}`,
    "--seed=0x1",
    ...preds.flatMap((p) => ["--witnesses", p]),
  ];
  const out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const hits: Record<string, number> = {};
  for (const p of preds) hits[p] = 0;
  for (const line of out.split("\n")) {
    const m = /^(.*) was witnessed in (\d+) trace\(s\)/.exec(line.trim());
    if (m && m[1]! in hits) hits[m[1]!] = Number(m[2]);
  }
  return hits;
}

/** Every assignment to `v` in the model, as written. */
function assignmentsTo(src: string, v: string): string[] {
  return [...src.matchAll(new RegExp(`${v}'\\s*=\\s*([^,\\n]+)`, "g"))].map((m) => m[1]!.trim());
}

const varNames = (src: string) => [...src.matchAll(/^\s*var (\w+):/gm)].map((m) => m[1]!);

let live = 0;
let vacuous = 0;
const vacuousList: string[] = [];

for (const model of MODELS) {
  const path = join(patternsDir, model.pattern, model.file);
  const src = readFileSync(path, "utf8");
  const knobs = knobsOf(src);
  const flippedPath = join(scratch, `flipped-${model.file}`);
  writeFileSync(flippedPath, flipKnobs(src));

  const targets = targetsOf(model.pattern).filter((t) => t.name.startsWith("contract-forbids-"));
  const preds = targets.map((t) => t.pred);
  const asIs = witnesses(path, model.depth, preds);
  const flipped = witnesses(flippedPath, model.depth, preds);

  console.log(`\n=== ${model.pattern}/${model.file}`);
  console.log(
    `    boolean contract knobs: ${knobs.length === 0 ? "(none)" : knobs.join(", ")}` +
      `   (${SAMPLES} random traces, depth ${model.depth})`,
  );
  for (const t of targets) {
    const a = asIs[t.pred]!;
    const b = flipped[t.pred]!;
    const verdictWord = b > 0 ? "LIVE" : "BY CONSTRUCTION";
    if (b > 0) live += 1;
    else {
      vacuous += 1;
      vacuousList.push(`${model.pattern}/${t.name}`);
    }
    console.log(
      `    ${verdictWord.padEnd(15)} ${t.name.padEnd(34)} shipped=${a} knobs-flipped=${b}   [${t.pred}]`,
    );
    if (b === 0) {
      // Say *why* no knob can reach it: show every assignment to the variables
      // the predicate names.
      for (const v of varNames(src)) {
        if (!new RegExp(`\\b${v}\\b`).test(t.pred) && !predUsesVia(src, t.pred, v)) continue;
        const asg = [...new Set(assignmentsTo(src, v))];
        console.log(`                      ${v}' ∈ { ${asg.join(" | ")} }`);
      }
    }
  }
}

/** A predicate may name a `val` that mentions the variable (e.g. noPhantomRows). */
function predUsesVia(src: string, pred: string, v: string): boolean {
  for (const m of src.matchAll(/^\s*val (\w+) =([\s\S]*?)$/gm)) {
    if (pred.includes(m[1]!) && new RegExp(`\\b${v}\\b`).test(m[2]!)) return true;
  }
  return false;
}

console.log(
  `\nSUMMARY  ${live} of ${live + vacuous} contract-forbids targets are live ` +
    `(a knob setting produces a witness); ${vacuous} are unreachable by construction:\n` +
    vacuousList.map((v) => `  - ${v}`).join("\n"),
);
