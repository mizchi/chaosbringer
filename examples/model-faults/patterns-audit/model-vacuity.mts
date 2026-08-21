/**
 * F6 — which `contract-forbids-*` targets are a proof and which are an
 * arithmetic identity, **asserted**.
 *
 *   cd examples/model-faults && npx tsx patterns-audit/model-vacuity.mts
 *   …                          npx tsx patterns-audit/model-vacuity.mts --json=/tmp/v.json
 *
 * Every unit's `enumerate.sh` ends with a block of targets whose comment says:
 * "The states the contract forbids. A witness here means the SPEC is wrong."
 * Those lines land in `targets.txt` next to the reachable ones and read as
 * verification results — each one cost a ~14s Apalache query. A target is only
 * a result if the model *could* have produced a witness, and the measurement
 * that decides it lives in one place: `../patterns/vacuity.mjs`.
 *
 * This file used to be a second implementation of that measurement, with its
 * own hand-written list of six patterns — which is the finding F6 is about,
 * committed inside the tool that closes it. It missed `stale-revalidate` and
 * both `model` units, disagreed with `vacuity.mjs` about token-refresh's depth
 * (5 against the 6 the unit's own `enumerate.sh` declares), reported `14 of 23`
 * where the repository has 30 such targets, and — because it was `console.log`
 * end to end and always exited 0 — a target flipping from LIVE to BY
 * CONSTRUCTION kept CI green. So it now *runs* the shared script and asserts
 * three things a print cannot:
 *
 *   1. the units it classified are exactly the units CI regenerates (the
 *      workflow's own glob, re-derived here — a discovery regression is
 *      indistinguishable from "there is nothing to classify");
 *   2. every `contract-forbids-*` row in every committed `targets.txt` carries
 *      the verdict this run measured, so a target that changes classification
 *      fails until the committed artifact is regenerated;
 *   3. the counts add up over the whole repository — one command, one number.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTargets } from "../targets.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const exampleRoot = join(here, "..");
const examplesRoot = join(exampleRoot, "..");
const vacuity = join(exampleRoot, "patterns", "vacuity.mjs");

interface TargetVerdict {
  name: string;
  pred: string;
  shipped: number;
  flipped: number;
  verdict: "live" | "by-construction";
}
interface UnitReport {
  id: string;
  dir: string;
  spec: string;
  depth: string;
  targets: TargetVerdict[];
}
interface VacuityReport {
  units: UnitReport[];
  allUnits: string[];
  live: number;
  byConstruction: number;
  total: number;
  unitCount: number;
}

/**
 * The workflow's discovery, re-derived: `.github/workflows/model-plans.yml`
 * globs `examples/*​/model/enumerate.sh examples/*​/patterns/*​/enumerate.sh`.
 * Kept independent of `vacuity.mjs`'s own walk on purpose — two derivations of
 * the same set can be compared, one cannot.
 */
function unitsCiRegenerates(): string[] {
  const out: string[] = [];
  const dirs = readdirSync(examplesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name)
    .sort();
  for (const example of dirs) {
    const candidates = [join(example, "model")];
    const patternsDir = join(examplesRoot, example, "patterns");
    if (existsSync(patternsDir)) {
      for (const unit of readdirSync(patternsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "node_modules")
        .map((e) => e.name)
        .sort()) {
        candidates.push(join(example, "patterns", unit));
      }
    }
    for (const id of candidates) {
      if (existsSync(join(examplesRoot, id, "enumerate.sh"))) out.push(id);
    }
  }
  return out;
}

/**
 * `contract-forbids-*` rows of one unit's committed `targets.txt`, as the
 * verdict word each carries. Read through the example's one `targets.txt`
 * parser (`../targets.ts`) — the same one `run.ts` reports coverage from, so
 * "what the committed file says" means the same thing in both places.
 */
function committedRows(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(join(dir, "targets.txt"))) return out;
  for (const row of loadTargets(dir)) {
    if (!row.target.startsWith("contract-forbids-")) continue;
    out.set(
      row.target,
      row.status === "reachable"
        ? "reachable"
        : row.verdict === undefined
          ? "unreachable"
          : `unreachable-${row.verdict}`,
    );
  }
  return out;
}

const failures: string[] = [];
function assert(label: string, cond: boolean, detail: string): void {
  console.log(`  PROOF   ${cond ? "ok" : "FAILED"}  ${label}: ${detail}`);
  if (!cond) failures.push(`${label}: ${detail}`);
}

// --- the measurement, from the one script that performs it -----------------
const forwarded = process.argv.slice(2).find((a) => a.startsWith("--json="));
const scratch = mkdtempSync(join(tmpdir(), "model-vacuity-"));
const jsonPath = join(scratch, "vacuity.json");
console.log(`$ node patterns/vacuity.mjs   (${basename(vacuity)}, the shared implementation)\n`);
const stdout = execFileSync("node", [vacuity, `--json=${jsonPath}`], {
  encoding: "utf8",
  cwd: exampleRoot,
});
console.log(stdout.trimEnd());
const report = JSON.parse(readFileSync(jsonPath, "utf8")) as VacuityReport;
// Hand the report on when a caller asked for it (audit.mts's F6 derives its
// unit list from this rather than from a literal of its own).
if (forwarded) writeFileSync(forwarded.slice("--json=".length), JSON.stringify(report, null, 2));

console.log("\n=== F6 assertions ===");

// 1. Discovery covers every unit CI regenerates.
const ci = unitsCiRegenerates();
const measured = report.units.map((u) => u.id).sort();
assert(
  "F6 every unit CI regenerates is classified",
  JSON.stringify(ci.slice().sort()) === JSON.stringify(measured),
  `workflow glob finds ${ci.length} unit(s), vacuity classified ${measured.length}` +
    (JSON.stringify(ci.slice().sort()) === JSON.stringify(measured)
      ? `: ${measured.join(", ")}`
      : `; missing from vacuity: [${ci.filter((u) => !measured.includes(u)).join(", ")}], ` +
        `unknown to CI: [${measured.filter((u) => !ci.includes(u)).join(", ")}]`),
);
assert(
  "F6 discovery is not empty",
  report.unitCount > 0 && report.total > 0,
  `${report.unitCount} unit(s), ${report.total} contract-forbids target(s)`,
);

// 2. Every committed row carries the verdict this run measured.
const wrong: string[] = [];
const unclassified: string[] = [];
const missing: string[] = [];
let committedTargets = 0;
for (const unit of report.units) {
  const rows = committedRows(unit.dir);
  committedTargets += rows.size;
  for (const [name, word] of rows) {
    if (word === "unreachable") unclassified.push(`${unit.id}/${name}`);
  }
  for (const t of unit.targets) {
    const word = rows.get(t.name);
    if (word === undefined) {
      missing.push(`${unit.id}/${t.name}`);
      continue;
    }
    const want = `unreachable-${t.verdict}`;
    if (word !== want) wrong.push(`${unit.id}/${t.name}: committed ${word}, measured ${want}`);
  }
}
assert(
  "F6 every contract-forbids row records whether a witness was possible",
  unclassified.length === 0,
  unclassified.length === 0
    ? `all ${committedTargets} row(s) classified live / by-construction`
    : `still unclassified: ${unclassified.join(", ")}`,
);
assert(
  "F6 the committed classification is the one this run measured",
  wrong.length === 0,
  wrong.length === 0
    ? `${report.total} row(s) agree with targets.txt`
    : `${wrong.length} disagreement(s) — re-run the unit's enumerate.sh: ${wrong.join("; ")}`,
);
assert(
  "F6 every measured target is recorded in its unit's targets.txt",
  missing.length === 0,
  missing.length === 0 ? "no target measured but unrecorded" : `missing rows: ${missing.join(", ")}`,
);

// 3. One number, true of the whole repository.
assert(
  "F6 the counts add up",
  report.live + report.byConstruction === report.total && committedTargets === report.total,
  `${report.live} live + ${report.byConstruction} by-construction = ${report.total} target(s) ` +
    `across ${report.unitCount} unit(s); targets.txt carries ${committedTargets}`,
);

console.log(
  failures.length === 0
    ? `\nF6 holds: ${report.live} of ${report.total} contract-forbids targets are live across ` +
        `${report.unitCount} model units, and every committed row says which`
    : `\n${failures.length} F6 assertion(s) did not hold:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
