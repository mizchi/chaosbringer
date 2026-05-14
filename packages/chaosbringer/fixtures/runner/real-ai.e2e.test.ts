/**
 * Opt-in real-AI E2E smoke (issue #95).
 *
 * Skipped unless `ANTHROPIC_API_KEY` is set in the env. CI does NOT
 * run this by default — invoke via `pnpm test:ai`. The test exercises
 * the live Anthropic pipeline that no other test in this repo hits,
 * so any drift in the provider's prompt shape / response parsing
 * surfaces here before reaching the published artifact.
 *
 * Cost: 1 turn ≈ a handful of haiku-tier calls. Budgeted via
 * `DriverBudget({ maxCalls: 6 })`.
 *
 * Phases exercised:
 *   1. Phase A: tracingDriver wraps aiDriver, runs against `/` of
 *      the fixture site under a `completion` goal aiming to reach
 *      `/about`. Successful trace → store the candidate.
 *   2. Phase D: investigate against `/console-error`. The AI's job
 *      is to land on /console-error and see the goal succeed on
 *      initial load (the fixture fires `console.error` on script
 *      run). Regression recipe should be captured.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aiDriver,
  anthropicDriverProvider,
  DriverBudget,
} from "../../src/drivers/index.js";
import { ChaosCrawler } from "../../src/crawler.js";
import { compositeDriver, weightedRandomDriver } from "../../src/drivers/index.js";
import {
  completionByUrl,
  completionGoal,
  extractCandidate,
  investigate,
  RecipeStore,
  tracingDriver,
  type ActionTrace,
} from "../../src/recipes/index.js";
import { startFixtureServer } from "../site/server.js";

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const describeReal = HAS_KEY ? describe : describe.skip;

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let storeDir: string;

beforeAll(async () => {
  if (!HAS_KEY) return;
  server = await startFixtureServer(0);
  storeDir = mkdtempSync(join(tmpdir(), "real-ai-"));
}, 30000);

afterAll(async () => {
  if (!HAS_KEY) return;
  await server?.close();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

describeReal("real Anthropic flywheel smoke", () => {
  it("Phase A: tracingDriver captures a successful trace from / to /about", async () => {
    const provider = anthropicDriverProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      // Use the cheapest current haiku tier. The provider's default
      // matches but pin explicitly so test cost is predictable.
      model: "claude-haiku-4-5-20251001",
    });

    const goal = completionGoal({
      task: 'Reach the page at path "/about" by clicking the appropriate link from the home page.',
      successCheck: completionByUrl("/about"),
      budget: { maxSteps: 6 },
    });

    let captured: ActionTrace | null = null;
    const inner = aiDriver({
      provider,
      goal: goal.objective,
      // Hard cap on LLM calls so a runaway test can't burn budget.
      budget: new DriverBudget({ maxCalls: 6 }),
    });
    const tracing = tracingDriver({
      inner,
      goal,
      onTraceComplete: (t) => {
        captured = t;
      },
    });

    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 2,
      maxActionsPerPage: 5,
      headless: true,
      driver: compositeDriver({
        drivers: [tracing, weightedRandomDriver()],
      }),
    });
    await crawler.start();

    expect(captured).not.toBeNull();
    expect(captured!.successful).toBe(true);
    expect(captured!.steps.length).toBeGreaterThan(0);

    // Verify the captured trace can be persisted as a candidate.
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });
    const candidate = extractCandidate(captured!, {
      name: "real-ai/visit-about",
      description: "AI captured visit-about flow",
    });
    store.upsert(candidate);
    expect(store.get("real-ai/visit-about")).not.toBeNull();
  }, 120000);

  it("Phase D: investigate reproduces /console-error and stores a regression recipe", async () => {
    const provider = anthropicDriverProvider({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: "claude-haiku-4-5-20251001",
    });
    const store = new RecipeStore({ localDir: storeDir, globalDir: false, silent: true });

    const result = await investigate({
      failure: {
        url: `${server.url}/console-error`,
        signature: "real-ai-console-error",
        errorMessages: ["fixture: intentional console error"],
        notes: "real-ai smoke",
      },
      driver: aiDriver({
        provider,
        budget: new DriverBudget({ maxCalls: 4 }),
      }),
      store,
      budget: 5,
    });
    expect(result.reproduced).toBe(true);
    expect(result.recipe).not.toBeNull();
    expect(result.recipe!.origin).toBe("regression");
  }, 120000);
});
