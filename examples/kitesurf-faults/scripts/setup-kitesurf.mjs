#!/usr/bin/env node
// Check the Kitesurf checkout named by KITESURF_DIR, then link it into this example.
//
// `@kitesurf/engine` is a private source package with no npm release, so the
// example cannot depend on it the usual way. Instead the integration run is
// pointed at a checkout explicitly, and refuses to start unless that checkout
// is the pinned revision (kitesurf-revision.json), has no tracked changes and
// has its build outputs staged. Every refusal exits 2 before wrangler starts:
// an integration run someone asked for is never reported as skipped or green.
//
// Usage: KITESURF_DIR=/path/to/kitesurf node scripts/setup-kitesurf.mjs
//        (KITESURF_REV=<sha> accepts a different revision; the artifact records it.)

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exit status for "the environment cannot run this", distinct from a failed scenario (1). */
export const EXIT_ENV = 2;

export const EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readManifest(exampleDir = EXAMPLE_DIR) {
  return JSON.parse(readFileSync(join(exampleDir, "kitesurf-revision.json"), "utf8"));
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * @param {{ env: Record<string, string | undefined>, manifest: { revision: string, requiredAssets: string[], buildCommand?: string } }} input
 * @returns {{ ok: boolean, exitCode: number, errors: string[], dir?: string, revision?: string, pinnedRevision: string, revisionOverridden: boolean }}
 */
export function validateKitesurf({ env, manifest }) {
  const pinnedRevision = manifest.revision;
  const expected = env.KITESURF_REV || pinnedRevision;
  const base = { pinnedRevision, revisionOverridden: expected !== pinnedRevision };
  const fail = (...errors) => ({ ok: false, exitCode: EXIT_ENV, errors, ...base });

  const raw = env.KITESURF_DIR;
  if (!raw) {
    return fail(
      `KITESURF_DIR is not set. Point it at a Kitesurf checkout of ${pinnedRevision} with its assets built (see examples/kitesurf-faults/README.md).`,
    );
  }
  if (!existsSync(raw) || !statSync(raw).isDirectory()) return fail(`KITESURF_DIR=${raw} is not a directory`);
  const dir = realpathSync(raw);

  // The top level must be the directory itself: a folder inside some other
  // repository would otherwise report that repository's HEAD.
  let top;
  try {
    top = realpathSync(git(dir, "rev-parse", "--show-toplevel"));
  } catch {
    return fail(`KITESURF_DIR=${dir} is not a git checkout`);
  }
  if (top !== dir) return fail(`KITESURF_DIR=${dir} is not a git checkout (it is inside ${top})`);

  const revision = git(dir, "rev-parse", "HEAD");
  const errors = [];
  if (revision !== expected) {
    errors.push(
      `Kitesurf revision mismatch: KITESURF_DIR is at ${revision}, expected ${expected}` +
        (base.revisionOverridden ? " (KITESURF_REV)" : " (kitesurf-revision.json)"),
    );
  }
  const dirty = git(dir, "status", "--porcelain", "--untracked-files=no");
  if (dirty) errors.push(`KITESURF_DIR has uncommitted changes to tracked files:\n${dirty}`);

  const missing = manifest.requiredAssets.filter((a) => !existsSync(join(dir, a)));
  if (missing.length > 0) {
    errors.push(
      `KITESURF_DIR is missing built assets:\n${missing.map((m) => `  - ${m}`).join("\n")}\n` +
        `Build them in the checkout with: ${manifest.buildCommand ?? "pnpm install && pnpm run build"}`,
    );
  }
  if (errors.length > 0) return { ...fail(...errors), dir, revision };
  return { ok: true, exitCode: 0, errors: [], dir, revision, ...base };
}

function relink(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  // lstat, not exists: a dangling link from an older checkout must go too.
  try {
    lstatSync(linkPath);
    rmSync(linkPath, { recursive: false, force: true });
  } catch {}
  symlinkSync(target, linkPath);
}

/**
 * Make the checkout visible to wrangler's bundler and asset server. The links
 * are absolute and made on every run, so no machine path is committed.
 */
export function linkKitesurf(exampleDir, kitesurfDir) {
  relink(join(kitesurfDir, "packages/engine"), join(exampleDir, "node_modules/@kitesurf/engine"));
  relink(join(kitesurfDir, "packages/engine/public"), join(exampleDir, ".kitesurf/public"));
}

/** Validate and link; print what is wrong and return the exit code. */
export function setup(env = process.env, exampleDir = EXAMPLE_DIR) {
  const result = validateKitesurf({ env, manifest: readManifest(exampleDir) });
  if (!result.ok) {
    for (const e of result.errors) console.error(`kitesurf-faults setup: ${e}`);
    return result;
  }
  linkKitesurf(exampleDir, result.dir);
  console.error(`kitesurf-faults setup: Kitesurf ${result.revision} at ${result.dir}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = setup().exitCode;
}
