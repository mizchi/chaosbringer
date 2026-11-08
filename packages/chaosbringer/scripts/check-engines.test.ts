import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The check lives in the repo root's scripts/, which has no test runner of its
// own, so its test runs in this package's suite.
const repo = new URL("../../../", import.meta.url).pathname;

describe("scripts/check-engines.mjs", () => {
  let work: string;

  beforeEach(() => {
    // The script reads the tree it sits in (`..` from itself), so run a copy
    // of it inside a scratch tree, with the root's node_modules for `yaml`.
    work = mkdtempSync(join(tmpdir(), "check-engines-"));
    mkdirSync(join(work, "scripts"));
    copyFileSync(join(repo, "scripts/check-engines.mjs"), join(work, "scripts/check-engines.mjs"));
    symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
    writeFileSync(join(work, "package.json"), JSON.stringify({ engines: { node: ">=22" } }));
    mkdirSync(join(work, "packages/pkg"), { recursive: true });
    writeFileSync(join(work, "packages/pkg/package.json"), JSON.stringify({ engines: { node: ">=22" } }));
    mkdirSync(join(work, ".github/workflows"), { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const run = (matrix: string) => {
    writeFileSync(
      join(work, ".github/workflows/ci.yml"),
      `jobs:\n  build-and-test:\n    strategy:\n      matrix:\n        node: ${matrix}\n`,
    );
    const r = spawnSync(process.execPath, [join(work, "scripts/check-engines.mjs")], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  };

  it("passes when the matrix's oldest major is the floor", () => {
    expect(run("[22, 24]").status).toBe(0);
  });

  it('reads the major of a "22.x" entry', () => {
    const r = run('["22.x", 24]');
    expect(r.out).not.toContain("NaN");
    expect(r.status).toBe(0);
  });

  it("names an entry that is not a Node major", () => {
    const r = run('["lts/*", 22]');
    expect(r.status).toBe(1);
    expect(r.out).toContain('matrix entry "lts/*" is not a Node major');
    expect(r.out).not.toContain("NaN");
  });

  it("fails when the oldest major is not the floor", () => {
    const r = run("[24]");
    expect(r.status).toBe(1);
    expect(r.out).toContain("oldest Node is 24");
  });
});
