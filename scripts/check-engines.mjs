#!/usr/bin/env node
/**
 * Every published package declares the same Node floor as the workspace root,
 * and CI's oldest Node is that floor.
 *
 * `engines.node` is a promise to consumers, and the only thing that keeps it
 * is CI running that Node. When Node 20 was dropped from CI the packages still
 * declared `>=20`, so the repo promised a runtime nothing tested; and seven
 * package.json files each holding their own copy of the floor is how one of
 * them gets left behind the next time it moves.
 *
 * So: the root's `engines.node` is `>=<major>`, every non-private package under
 * packages/ declares exactly that, and the lowest entry of ci.yml's
 * build-and-test `node` matrix is that major, so a change that needs a newer
 * Node fails there instead of on a consumer's machine.
 *
 * Usage: `pnpm check:engines` (from the repo root, after `pnpm install`: the
 * workflow is read with the `yaml` package).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const problems = [];

const floor = readJson(join(root, "package.json")).engines?.node;
const major = /^>=(\d+)$/.exec(floor ?? "")?.[1];
if (!major) {
  console.error(`package.json: engines.node is ${JSON.stringify(floor)}, expected ">=<major>"`);
  process.exit(2);
}

let checked = 0;
for (const dir of readdirSync(join(root, "packages")).sort()) {
  const path = join(root, "packages", dir, "package.json");
  if (!existsSync(path)) continue;
  const pkg = readJson(path);
  if (pkg.private) continue;
  checked++;
  const declared = pkg.engines?.node;
  if (declared !== floor) {
    problems.push(`packages/${dir}/package.json: engines.node is ${JSON.stringify(declared)}, the root's is "${floor}"`);
  }
}

const ci = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const matrix = ci?.jobs?.["build-and-test"]?.strategy?.matrix?.node;
if (!Array.isArray(matrix) || matrix.length === 0) {
  problems.push(".github/workflows/ci.yml: build-and-test has no `strategy.matrix.node` list");
} else {
  // setup-node takes more than a bare major ("22.x", "22.4", "lts/*"), and one
  // entry that is not a number would make Math.min NaN and report a floor
  // mismatch that is not there. Read each entry's leading major, and name an
  // entry that has none instead of comparing it.
  const majors = [];
  for (const entry of matrix) {
    const m = /^(\d+)(?:\.|$)/.exec(String(entry))?.[1];
    if (m) majors.push(Number(m));
    else problems.push(`.github/workflows/ci.yml: build-and-test matrix entry ${JSON.stringify(entry)} is not a Node major`);
  }
  const oldest = Math.min(...majors);
  if (majors.length > 0 && oldest !== Number(major)) {
    problems.push(
      `.github/workflows/ci.yml: build-and-test's oldest Node is ${oldest}, but engines.node is "${floor}": ` +
        `CI must run the floor it promises`,
    );
  }
}

if (problems.length > 0) {
  console.log(`check-engines: ${problems.length} problem(s)`);
  for (const p of problems) console.log("  FAIL " + p);
  process.exit(1);
}
console.log(`check-engines: root and ${checked} published packages declare engines.node "${floor}", and CI's oldest Node is ${major}`);
