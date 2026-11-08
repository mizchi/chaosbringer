import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BUDGET_FLOORS, emitBudgets, spanMedians } from "../src/stats";
import type { PerfReport } from "../src/report-types";

// `lightbringer run --emit-budgets --floor … --gate` end to end, on the built
// CLI: the --floor values must reach the emitted budgets and the file's
// "$emit" record, and --gate must read that file back. A scenario on
// about:blank needs no server and measures in a couple of seconds.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("--floor reaches the emitted budgets, and --gate reads them back", () => {
  test.setTimeout(60_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lb-cli-floor-"));
  try {
    const scenario = path.join(dir, "blank.json");
    fs.writeFileSync(scenario, JSON.stringify({ url: "about:blank", steps: [{ name: "idle", wait: 10 }] }));
    const out = path.join(dir, "out");
    const r = spawnSync(
      process.execPath,
      [CLI, "run", scenario, "--repeat", "2", "--out", out, "--emit-budgets", "--floor", "scriptMs=500", "--floor=requestCount=0", "--gate"],
      { encoding: "utf8", timeout: 50_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("floors durationMs+34 scriptMs+500");
    expect(r.stdout).toContain("gate passed.");

    const floors = { ...DEFAULT_BUDGET_FLOORS, scriptMs: 500, requestCount: 0 };
    const file = JSON.parse(fs.readFileSync(path.join(out, "lightbringer.budgets.json"), "utf8"));
    expect(file.$emit).toEqual({ headroom: 1.25, floors });
    const runs = ["blank.run0.json", "blank.run1.json"].map(
      (f) => JSON.parse(fs.readFileSync(path.join(out, f), "utf8")) as PerfReport,
    );
    expect(file.blank).toEqual(emitBudgets(spanMedians(runs), { floors }));
    // 500 is far above anything an idle step measures: only the floor sets it.
    expect(file.blank.idle.scriptMs).toBeGreaterThanOrEqual(500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
