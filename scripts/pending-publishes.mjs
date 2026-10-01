#!/usr/bin/env node
/**
 * The workspace packages whose package.json version is not on npm yet, one
 * directory per line, dependencies before the packages that use them.
 *
 * publish.yml publishes them in this order in one run, so a release that
 * bumps playwright-faults and chaosbringer together puts playwright-faults on
 * npm before chaosbringer's tarball (which depends on it) is checked and
 * published. Private packages are skipped.
 *
 * Usage: `node scripts/pending-publishes.mjs` → `packages/playwright-faults\npackages/chaosbringer`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packages = new Map();
for (const d of readdirSync(join(root, "packages")).sort()) {
  const file = join(root, "packages", d, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.private) continue;
  packages.set(pkg.name, { dir: `packages/${d}`, pkg });
}

const onNpm = (name, version) => {
  try {
    return execFileSync("npm", ["view", "--prefer-online", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === version;
  } catch {
    return false;
  }
};

// Depth-first over workspace dependencies, so each package follows its deps.
const order = [];
const seen = new Set();
const visit = (name, path = []) => {
  if (seen.has(name)) return;
  if (path.includes(name)) throw new Error(`dependency cycle: ${[...path, name].join(" → ")}`);
  const { pkg } = packages.get(name);
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  for (const [dep, range] of Object.entries(deps)) {
    if (String(range).startsWith("workspace:") && packages.has(dep)) visit(dep, [...path, name]);
  }
  seen.add(name);
  order.push(name);
};
for (const name of packages.keys()) visit(name);

for (const name of order) {
  const { dir, pkg } = packages.get(name);
  if (!onNpm(name, pkg.version)) console.log(dir);
}
