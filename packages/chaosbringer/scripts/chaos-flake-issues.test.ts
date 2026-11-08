import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = new URL("./chaos-flake-issues.ts", import.meta.url).pathname;
// Wherever pnpm put it: the workflow's `pnpm tsx` finds the hoisted one.
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

describe("chaos-flake-issues.ts", () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "chaos-flake-issues-"));
    // Stands in for the GitHub CLI: records each call's argv, and answers
    // `gh issue list` with no open issues.
    writeFileSync(
      join(work, "gh"),
      [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        'require("node:fs").appendFileSync(process.env.OUT, `${JSON.stringify(argv)}\\n`);',
        'if (argv[1] === "list") console.log("[]");',
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(work, "flake.json"),
      JSON.stringify({
        runs: 10,
        decidable: true,
        stableClusters: [],
        flakyClusters: [
          { key: "console|boom", type: "console", fingerprint: "boom", runsWithCluster: 3, perRunCounts: [1, 0, 1] },
        ],
        flakyPages: [],
        durations: [],
      }),
    );
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** Runs the script, and returns the argv of each `gh` call it made. */
  function reconcile(env: Record<string, string>): string[][] {
    const out = join(work, "out");
    writeFileSync(out, "");
    execFileSync(process.execPath, [tsx, script, join(work, "flake.json")], {
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, OUT: out, GH_REPO: "o/r", ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  it("gives an opened issue the flake command the workflow ran, to reproduce it", () => {
    // It used to print `pnpm exec chaosbringer flake --url <fixture-url> --runs N`,
    // which is "Command not found" in the monorepo and lacks the run's --seed
    // and limits, so it reproduced nothing.
    const command =
      "node dist/cli.js flake --url http://127.0.0.1:4455 --runs 10 --seed 1 --max-pages 30 --max-actions 5 --output flake.json";
    const create = reconcile({ FLAKE_COMMAND: command }).find((argv) => argv[0] === "issue" && argv[1] === "create");
    const body = create?.[create.indexOf("--body") + 1];
    expect(body).toContain(`\n\`\`\`\n${command}\n\`\`\``);
  });

  it("refuses to run without the flake command", () => {
    expect(() => reconcile({ FLAKE_COMMAND: "" })).toThrow(/FLAKE_COMMAND must be set/);
  });
});
