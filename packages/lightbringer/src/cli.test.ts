// cli.ts parses process.argv and starts measuring as soon as it is imported,
// so its --floor wiring is checked on the built CLI (CI builds before the unit
// tests). Only refusals here: they exit before a browser starts. The emit and
// gate with --floor, which need one, are examples/cli-floor.spec.ts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "../dist/cli.js");

describe("lightbringer run --floor (built CLI)", () => {
  it.each([
    [["--floor", "bogusMs=1"], '[lightbringer] --floor "bogusMs=1": unknown metric "bogusMs"'],
    [["--floor", "scriptMs=-1"], '[lightbringer] --floor "scriptMs=-1": n must be a number >= 0'],
    [["--floor"], "[lightbringer] --floor needs a value"],
  ])("refuses %j with exit 1 before measuring anything", (flags, message) => {
    expect(fs.existsSync(CLI), `${CLI} is missing: run pnpm build first`).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-cli-floor-"));
    try {
      const out = path.join(dir, "out");
      // The scenario does not exist either: the floors are checked before it is read.
      const r = spawnSync(
        process.execPath,
        [CLI, "run", path.join(dir, "missing.json"), "--emit-budgets", "--out", out, ...flags],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(message);
      // No run started: nothing was written to --out.
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
