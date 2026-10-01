#!/usr/bin/env node
/**
 * Refuses to publish a package whose workspace dependencies are not on npm in
 * the form it was built against.
 *
 * chaosbringer@0.10.0 shipped importing `buildDecisionHelperSource` from
 * `@mizchi/playwright-faults`. That export was added after
 * playwright-faults 0.2.0, and playwright-faults was never released again, so
 * pnpm rewrote `workspace:^` to `^0.2.0` — the version still in its
 * package.json — and every consumer got "does not provide an export named …".
 * Local CI passed, because in the workspace the dependency is the source tree.
 *
 * Two checks, both against what a consumer actually gets:
 *
 * 1. For each `workspace:` dependency, its current version is on npm, and its
 *    shipped source has not changed since the tag of that version
 *    (`<dir>-v<version>`). A change means the version on npm is not the code
 *    this package was built and tested with: release the dependency first.
 * 2. The package is packed the way `pnpm publish` packs it, installed into an
 *    empty directory from the registry, and every `exports` entry is
 *    imported. This is the consumer's `import "chaosbringer"`.
 *
 * Usage: `node scripts/check-publish-deps.mjs packages/<dir>` after
 * `pnpm -r build`. `--no-smoke` skips the install (offline). publish.yml
 * runs it before every publish, after the dependencies it publishes first.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const smoke = !args.includes("--no-smoke");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: check-publish-deps.mjs packages/<dir> [--no-smoke]");
  process.exit(2);
}
const targetDir = resolve(root, target);
const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const pkg = readPkg(targetDir);

/** Workspace packages by npm name. */
const workspace = new Map();
for (const d of readdirSync(join(root, "packages"))) {
  const dir = join(root, "packages", d);
  if (!existsSync(join(dir, "package.json"))) continue;
  const p = readPkg(dir);
  workspace.set(p.name, { dir, short: d, version: p.version });
}

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const problems = [];

/**
 * publish.yml checks a package right after publishing its dependencies, and
 * the registry can take a little while to serve a version it just accepted.
 * Retry a call that fails or returns something else before believing it.
 * (`--prefer-online` on the npm calls keeps npm's own cache, which holds a
 * package's metadata for minutes, from answering for the registry.)
 */
async function settle(fn, ok = () => true, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      const value = fn();
      if (ok(value) || i === attempts) return value;
    } catch (e) {
      if (i === attempts) throw e;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** Files under a package that do not end up in what it ships. */
const NOT_SHIPPED = /(?:^|\/)(?:CHANGELOG\.md|README\.md|tests?\/.*|[^/]*\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?|vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/;

const deps = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
for (const [name, range] of Object.entries(deps)) {
  if (!String(range).startsWith("workspace:")) continue;
  const dep = workspace.get(name);
  if (!dep) {
    problems.push(`${name}: declared as ${range} but is not a package under packages/`);
    continue;
  }
  let published = "";
  try {
    published = await settle(() => run("npm", ["view", "--prefer-online", `${name}@${dep.version}`, "version"]).trim(), (v) => v === dep.version);
  } catch {}
  if (published !== dep.version) {
    problems.push(`${name}@${dep.version} is not on npm. Publish it before ${pkg.name}.`);
    continue;
  }
  const tag = `${dep.short}-v${dep.version}`;
  try {
    run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root });
  } catch {
    // lightbringer's early versions were tagged in its old repository. Compare
    // what npm serves with what this tree would pack instead.
    const changed = packedDifference(name, dep);
    if (changed.length > 0) problems.push(staleMessage(name, dep, `the tarball on npm`, changed));
    continue;
  }
  const rel = `packages/${dep.short}`;
  const changed = run("git", ["diff", "--name-only", tag, "HEAD", "--", rel], { cwd: root })
    .split("\n")
    .filter((f) => f && f !== `${rel}/package.json` && !NOT_SHIPPED.test(f.slice(rel.length + 1)));
  if (changed.length > 0) problems.push(staleMessage(name, dep, tag, changed));
}

function staleMessage(name, dep, since, changed) {
  return (
    `${name} has changed since ${since}, but its version is still ${dep.version}, so ${pkg.name} would get the old code from npm. ` +
    `Release ${name} first, then ${pkg.name}. Changed:\n    ${changed.slice(0, 10).join("\n    ")}${changed.length > 10 ? `\n    … ${changed.length - 10} more` : ""}`
  );
}

/** Files that differ between the tarball npm serves for `dep.version` and what this tree packs (needs a build). */
function packedDifference(name, dep) {
  const work = mkdtempSync(join(tmpdir(), "check-publish-dep-"));
  const unpack = (from, into) => {
    run("mkdir", ["-p", into]);
    run("tar", ["-xzf", from, "-C", into, "--strip-components=1"]);
  };
  for (const d of ["npm", "local"]) run("mkdir", ["-p", join(work, d)]);
  run("npm", ["pack", `${name}@${dep.version}`, "--pack-destination", join(work, "npm")], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  run("pnpm", ["pack", "--pack-destination", join(work, "local")], { cwd: dep.dir });
  const tgz = (d) => join(work, d, readdirSync(join(work, d)).find((f) => f.endsWith(".tgz")));
  unpack(tgz("npm"), join(work, "a"));
  unpack(tgz("local"), join(work, "b"));
  let out = "";
  try {
    out = run("diff", ["-rq", "-x", "package.json", "-x", "README.md", "-x", "CHANGELOG.md", join(work, "a"), join(work, "b")]);
  } catch (e) {
    out = e.stdout ?? "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replaceAll(`${join(work, "a")}/`, "").replaceAll(`${join(work, "b")}/`, "").replace(/^Files (\S+) and \S+ differ$/, "$1"));
}

if (problems.length === 0 && smoke) {
  const work = mkdtempSync(join(tmpdir(), "check-publish-"));
  // `pnpm pack` rewrites `workspace:` ranges exactly as `pnpm publish` does.
  run("pnpm", ["pack", "--pack-destination", work], { cwd: targetDir });
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  const consumer = join(work, "consumer");
  run("mkdir", ["-p", consumer]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  try {
    // Peers too, optional ones included: `lightbringer`'s `.` entry needs the
    // optional `@playwright/test`, and a consumer importing it has it.
    const peers = Object.entries(pkg.peerDependencies ?? {}).map(([n, r]) => `${n}@${r}`);
    await settle(() => run("npm", ["install", "--prefer-online", "--ignore-scripts", "--no-audit", "--no-fund", join(work, tarball), ...peers], { cwd: consumer }));
  } catch (e) {
    problems.push(`installing the packed ${pkg.name} from npm failed:\n${e.stderr || e.message}`);
  }
  if (problems.length === 0) {
    for (const entry of Object.keys(pkg.exports ?? { ".": null })) {
      if (entry.includes("*") || entry === "./package.json") continue;
      const spec = entry === "." ? pkg.name : `${pkg.name}/${entry.slice(2)}`;
      try {
        run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(spec)})`], { cwd: consumer });
      } catch (e) {
        problems.push(`import "${spec}" fails when installed from npm:\n${(e.stderr || e.message).trim().split("\n").slice(0, 8).join("\n")}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`${pkg.name}@${pkg.version} must not be published yet:\n`);
  for (const p of problems) console.error(`- ${p}\n`);
  process.exit(1);
}
console.log(`${pkg.name}@${pkg.version}: workspace dependencies match npm${smoke ? ", and every entry imports when installed from npm" : ""}`);
