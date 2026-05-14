/**
 * E2E smoke for `investigate()` — Phase D of the AI flywheel.
 *
 * We don't have an AI key in CI, so we drive `investigate()` with a
 * "scripted advisor" Driver: it picks whichever candidate matches a
 * regex from the failure context. This is exactly the shape an AI
 * advisor would return, just deterministic. Behaviour under test is
 * the orchestration — discoverCandidates + executePick + trace
 * finalisation + regression recipe upsert.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  investigate,
  RecipeStore,
} from "../../src/recipes/index.js";
import type { Driver, DriverPick } from "../../src/drivers/types.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;
let storeDir: string;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
  storeDir = mkdtempSync(join(tmpdir(), "investigate-e2e-"));
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
  rmSync(storeDir, { recursive: true, force: true });
});

/**
 * Picks the first candidate whose description includes a needle. Falls
 * back to skip when nothing matches — that's what an AI would do too.
 */
function pickingDriver(needle: RegExp): Driver {
  return {
    name: "needle",
    async selectAction(step): Promise<DriverPick | null> {
      const idx = step.candidates.findIndex((c) => needle.test(c.description));
      if (idx < 0) return { kind: "skip" };
      return { kind: "select", index: idx, reasoning: `matched ${needle}` };
    },
  };
}

describe("investigate() against fixture", () => {
  it("reproduces a console-error failure and stores a regression recipe", async () => {
    const store = new RecipeStore({
      localDir: storeDir,
      globalDir: false,
      silent: true,
      minRuns: 1,
      minSuccessRate: 1,
    });

    const result = await investigate({
      failure: {
        url: `${server.url}/console-error`,
        signature: "console-error-fixture",
        errorMessages: ["fixture: intentional console error"],
        notes: "fires a console.error on page load",
      },
      driver: pickingDriver(/console\.error/i),
      store,
      browser,
      budget: 5,
    });

    expect(result.reproduced).toBe(true);
    expect(result.recipe).not.toBeNull();
    expect(result.recipe!.origin).toBe("regression");
    expect(result.recipe!.steps.length).toBeGreaterThan(0);
    expect(result.trace.steps.length).toBeGreaterThan(0);

    // Persisted to disk with the expected name format.
    const persisted = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    expect(persisted.get("regression/console-error-fixture")).not.toBeNull();
  }, 60000);

  it("returns reproduced=false when the AI cannot trigger the failure", async () => {
    const store = new RecipeStore({
      localDir: mkdtempSync(join(tmpdir(), "no-repro-")),
      globalDir: false,
      silent: true,
    });

    const result = await investigate({
      failure: {
        url: `${server.url}/about`,             // landing page with no errors
        signature: "no-repro",
        errorMessages: ["something we cannot trigger"],
      },
      // Driver clicks the "back" link forever — never triggers an error.
      driver: pickingDriver(/back/i),
      store,
      browser,
      budget: 3,
    });

    expect(result.reproduced).toBe(false);
    expect(result.recipe).toBeNull();
  }, 60000);
});
