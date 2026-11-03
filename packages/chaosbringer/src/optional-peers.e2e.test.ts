/**
 * The built CLI in a project that has not installed chaosbringer's optional
 * peers: `--axe` without axe-core ran the whole crawl, then failed every page
 * with one "requires the axe-core package" invariant violation and exit 1,
 * as if the site had accessibility bugs. `--visual-baseline` without
 * pixelmatch / pngjs passed its first run (writing baselines needs neither)
 * and failed every page of the second.
 *
 * Nothing is uninstalled from the repo: a temp tree gets a copy of `dist/`
 * (a symlinked file resolves from where it really is, which has the peers)
 * and a `node_modules` that links every package this repo installed except
 * those three. The spawned CLI finds no browser either
 * (PLAYWRIGHT_BROWSERS_PATH is empty), so a refusal that came after the
 * launch would be Playwright's "Executable doesn't exist" instead.
 *
 * Reads `dist/`, as barrel-imports.test.ts does: build first.
 */
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const PEERS = ["axe-core", "pixelmatch", "pngjs"];
/** Nothing listens here; a crawl that got this far would fail, not hang. */
const URL_ARG = ["--url", "http://127.0.0.1:9/"];
/** Where this repo's packages are: hoisted to the root, workspace links in the package. */
const MODULE_DIRS = [join(PACKAGE_DIR, "..", "..", "node_modules"), join(PACKAGE_DIR, "node_modules")];

let tree: string;
let cliPath: string;

/** Link every package in `from` into `to`, scope by scope, except the peers and chaosbringer. */
function linkPackages(from: string, to: string): void {
  let names: string[];
  try {
    names = readdirSync(from);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") || PEERS.includes(name) || name === "chaosbringer") continue;
    if (name.startsWith("@")) {
      mkdirSync(join(to, name), { recursive: true });
      linkPackages(join(from, name), join(to, name));
      continue;
    }
    try {
      symlinkSync(join(from, name), join(to, name), "dir");
    } catch {
      // Listed under both roots: the first link wins, as Node's lookup would.
    }
  }
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd: tree, timeout: 60_000, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(tree, "no-browsers") } },
      (err, stdout, stderr) => {
        const status = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), "chaos-no-peers-"));
  const pkg = join(tree, "node_modules", "chaosbringer");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(tree, "no-browsers"));
  cpSync(join(PACKAGE_DIR, "dist"), join(pkg, "dist"), { recursive: true });
  cpSync(join(PACKAGE_DIR, "package.json"), join(pkg, "package.json"));
  for (const dir of MODULE_DIRS) linkPackages(dir, join(tree, "node_modules"));
  cliPath = join(pkg, "dist", "cli.js");
});

afterAll(() => {
  if (tree) rmSync(tree, { recursive: true, force: true });
});

describe("the CLI without its optional peers installed", () => {
  it("is a tree where the peers do not resolve, and everything else does", () => {
    // Without this the rows below could pass on a machine with a stray
    // node_modules above the temp dir, and test nothing.
    const req = createRequire(cliPath);
    for (const name of PEERS) expect(() => req.resolve(name), name).toThrow();
    expect(() => req.resolve("playwright")).not.toThrow();
  });

  it.each([
    [[...URL_ARG, "--axe"], "chaosbringer: --axe needs axe-core: an optional peer dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)"],
    // The alias, named as typed; the data-safety presets beside it need nothing.
    [
      [...URL_ARG, "--invariants", "data-safety,axe"],
      "chaosbringer: --invariants axe needs axe-core: an optional peer dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)",
    ],
    [
      ["scan", ...URL_ARG, "--invariants", "axe"],
      "chaosbringer scan: --invariants axe needs axe-core: an optional peer dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)",
    ],
    // Its first run, which writes the baselines and needed neither, passed.
    [
      [...URL_ARG, "--visual-baseline", "vb"],
      "chaosbringer: --visual-baseline needs pixelmatch and pngjs: optional peer dependencies that are not installed. " +
        "Install them with `pnpm add -D pixelmatch pngjs` (or `npm install -D pixelmatch pngjs`)",
    ],
    [
      ["scan", ...URL_ARG, "--axe"],
      "chaosbringer scan: --axe needs axe-core: an optional peer dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)",
    ],
    // Once, for the workers: each of them would refuse it on its own.
    [
      ["shard", "--count", "2", ...URL_ARG, "--axe"],
      "chaosbringer shard: --axe needs axe-core: an optional peer dependency that is not installed. Install it with `pnpm add -D axe-core` (or `npm install -D axe-core`)",
    ],
  ])("%j refuses in one line with exit 2, before a browser starts", async (args, line) => {
    const r = await run(args);
    expect(r.stderr.trimEnd().split("\n")).toEqual([line]);
    expect(r.stdout).toBe("");
    expect(r.status).toBe(2);
  }, 60_000);
});
